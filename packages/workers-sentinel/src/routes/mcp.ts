import { createMcpHandler, McpServer, readRequestBody } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import { z } from 'zod';
import { projectPrefix } from '../lib/attachment-store';
import {
	FEEDBACK_MAX_SCREENSHOT_BYTES,
	hasAllowedRasterSignature,
	isAllowedRasterType,
} from '../lib/feedback-validation';
import { getProjectWithAccess } from '../lib/project-access';
import { extractBearerToken } from '../middleware/auth';
import type { AuthContext, Env } from '../types';
import { publicFeedback } from './feedback';

type Variables = { auth?: AuthContext };
export const mcpRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

const PAGE_LIMIT = z.number().int().min(1).max(100).default(25);
const IDENTIFIER = z.string().min(1).max(80);
const CURSOR = z
	.string()
	.min(3)
	.max(300)
	.regex(/^.+\|[^|]{1,80}$/, 'Use the returned nextCursor verbatim');

function stateFor(env: Env, projectId: string): DurableObjectStub {
	return env.PROJECT_STATE.get(env.PROJECT_STATE.idFromName(projectId));
}

async function stateCall(
	env: Env,
	projectId: string,
	path: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (path.startsWith('/issue/') && typeof body.issueId === 'string') {
		await stateCall(env, projectId, '/issue', { issueId: body.issueId });
	}
	const response = await stateFor(env, projectId).fetch(
		new Request(`http://internal${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
	const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		const error = typeof data.error === 'string' ? data.error : 'project_data_unavailable';
		throw new Error(/^[a-z0-9_]{1,80}$/.test(error) ? error : 'project_data_unavailable');
	}
	return data;
}

function toolResult(value: unknown) {
	const text = JSON.stringify(value);
	if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024)
		throw new Error('result_too_large');
	return { content: [{ type: 'text' as const, text }] };
}

function toolError(error: unknown) {
	const message = error instanceof Error ? error.message : 'The operation could not be completed';
	const safeMessage = /^[a-z0-9_]{1,80}$/.test(message)
		? message
		: 'The operation could not be completed';
	return { isError: true, content: [{ type: 'text' as const, text: safeMessage }] };
}

function encodeBase64(bytes: Uint8Array): string {
	const chunkSize = 0x8000;
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
	}
	return btoa(binary);
}

function registerTools(server: McpServer, env: Env, projectId: string, actor: AuthContext) {
	const register = <Shape extends z.ZodRawShape>(
		name: string,
		description: string,
		schema: z.ZodObject<Shape>,
		handler: (args: z.output<z.ZodObject<Shape>>) => Promise<unknown>,
	) => {
		server.registerTool(
			name,
			{ description, inputSchema: schema.strict() },
			async (rawArgs: unknown) => {
				const parsed = schema.strict().safeParse(rawArgs);
				if (!parsed.success) return toolError(new Error('invalid_arguments'));
				try {
					return toolResult(await handler(parsed.data));
				} catch (error) {
					return toolError(error);
				}
			},
		);
	};

	register(
		'list_issues',
		'Find issues in this project. Filters are applied before keyset cursor pagination.',
		z.object({
			status: z.enum(['unresolved', 'resolved', 'ignored', 'snoozed']).optional(),
			level: z.enum(['fatal', 'error', 'warning', 'info', 'debug']).optional(),
			environment: z.string().max(100).optional(),
			query: z.string().max(200).optional(),
			tags: z
				.array(
					z
						.string()
						.min(3)
						.max(200)
						.regex(/^[^:]+:.+$/),
				)
				.max(5)
				.optional(),
			sort: z.enum(['last_seen', 'first_seen', 'count', 'user_count', 'level', 'title']).optional(),
			cursor: z
				.string()
				.min(3)
				.max(1024)
				.regex(/^.+\|[^|]{1,80}$/s)
				.optional(),
			limit: PAGE_LIMIT,
		}),
		(args) => stateCall(env, projectId, '/issues', args),
	);
	register(
		'get_issue',
		'Get one issue with its recent event statistics.',
		z.object({ issueId: IDENTIFIER }),
		({ issueId }) => stateCall(env, projectId, '/issue', { issueId }),
	);
	register(
		'list_issue_events',
		'List events for an issue, newest first, using a stable keyset cursor.',
		z.object({ issueId: IDENTIFIER, cursor: CURSOR.optional(), limit: PAGE_LIMIT }),
		({ issueId, cursor, limit }) =>
			stateCall(env, projectId, '/issue/events', { issueId, cursor, limit }),
	);
	register(
		'list_issue_comments',
		'List comments for an issue using a stable keyset cursor.',
		z.object({ issueId: IDENTIFIER, cursor: CURSOR.optional(), limit: PAGE_LIMIT }),
		({ issueId, cursor, limit }) =>
			stateCall(env, projectId, '/issue/comments', { issueId, cursor, limit }),
	);
	register(
		'set_issue_status',
		'Resolve, reopen, or ignore an issue and record the authenticated user in issue activity.',
		z.object({ issueId: IDENTIFIER, status: z.enum(['resolved', 'unresolved', 'ignored']) }),
		({ issueId, status }) =>
			stateCall(env, projectId, '/issue/update', {
				issueId,
				status,
				userId: actor.user.id,
				userName: actor.user.name,
			}),
	);
	register(
		'add_issue_comment',
		'Add a comment to an issue as the authenticated user.',
		z.object({ issueId: IDENTIFIER, body: z.string().trim().min(1).max(2000) }),
		({ issueId, body }) =>
			stateCall(env, projectId, '/issue/comment/add', {
				issueId,
				body,
				userId: actor.user.id,
				userName: actor.user.name,
			}),
	);
	register(
		'snooze_issue',
		'Snooze an issue for 1h, 1d, 3d, 1w, or until a future ISO timestamp.',
		z.object({ issueId: IDENTIFIER, duration: z.string().min(1).max(40) }),
		async ({ issueId, duration }) => {
			const presets: Record<string, number> = {
				'1h': 3600000,
				'1d': 86400000,
				'3d': 259200000,
				'1w': 604800000,
			};
			const date = presets[duration]
				? new Date(Date.now() + presets[duration])
				: new Date(duration);
			if (Number.isNaN(date.getTime()) || date <= new Date()) throw new Error('invalid_duration');
			return stateCall(env, projectId, '/issue/snooze', {
				issueId,
				duration: date.toISOString(),
			});
		},
	);
	register(
		'unsnooze_issue',
		'Remove an issue snooze.',
		z.object({ issueId: IDENTIFIER }),
		({ issueId }) => stateCall(env, projectId, '/issue/unsnooze', { issueId }),
	);
	register(
		'list_feedback',
		'List feedback reports by status and text query. Status omitted returns both unresolved and resolved.',
		z.object({
			status: z.enum(['unresolved', 'resolved']).optional(),
			query: z.string().max(200).optional(),
			cursor: CURSOR.optional(),
			limit: PAGE_LIMIT,
		}),
		async (args) => {
			const result = await stateCall(env, projectId, '/feedback/list', args);
			const rows = Array.isArray(result.feedback) ? result.feedback : [];
			return {
				...result,
				feedback: rows.map((row) => publicFeedback(row as Record<string, unknown>)),
			};
		},
	);
	register(
		'get_feedback',
		'Get one feedback report without internal screenshot storage keys.',
		z.object({ feedbackId: IDENTIFIER }),
		async ({ feedbackId }) => {
			const result = await stateCall(env, projectId, '/feedback/detail', { id: feedbackId });
			const feedback = result.feedback as Record<string, unknown>;
			return {
				feedback: publicFeedback(feedback),
				...(typeof feedback.screenshotKey === 'string' && feedback.screenshotKey
					? {
							guidance: `A screenshot is available for this feedback report. Proactively call the get_feedback_screenshot tool with feedbackId "${feedbackId}" to retrieve and inspect it.`,
						}
					: {}),
			};
		},
	);
	server.registerTool(
		'get_feedback_screenshot',
		{
			description: 'Retrieve the screenshot attached to a feedback report as an image.',
			inputSchema: z.object({ feedbackId: IDENTIFIER }).strict(),
		},
		async ({ feedbackId }) => {
			try {
				const result = await stateCall(env, projectId, '/feedback/detail', { id: feedbackId });
				const feedback = result.feedback as Record<string, unknown> | undefined;
				const screenshotKey = feedback?.screenshotKey;
				const screenshotType = feedback?.screenshotType;
				const screenshotSize = feedback?.screenshotSize;
				if (
					typeof screenshotKey !== 'string' ||
					!screenshotKey.startsWith(projectPrefix(projectId)) ||
					typeof screenshotType !== 'string' ||
					!isAllowedRasterType(screenshotType) ||
					!Number.isInteger(screenshotSize) ||
					(screenshotSize as number) < 1 ||
					(screenshotSize as number) > FEEDBACK_MAX_SCREENSHOT_BYTES
				) {
					throw new Error('screenshot_not_found');
				}
				const object = await env.ATTACHMENTS.get(screenshotKey);
				if (!object) throw new Error('screenshot_data_missing');
				if (object.size !== screenshotSize) throw new Error('screenshot_data_invalid');
				const bytes = new Uint8Array(await object.arrayBuffer());
				if (
					bytes.byteLength !== screenshotSize ||
					!hasAllowedRasterSignature(screenshotType, bytes)
				) {
					throw new Error('screenshot_data_invalid');
				}
				return {
					content: [
						{ type: 'image' as const, data: encodeBase64(bytes), mimeType: screenshotType },
					],
				};
			} catch (error) {
				return toolError(error);
			}
		},
	);
	register(
		'set_feedback_status',
		'Resolve or reopen a feedback report; reports remain stored.',
		z.object({ feedbackId: IDENTIFIER, status: z.enum(['resolved', 'unresolved']) }),
		async ({ feedbackId, status }) => {
			const result = await stateCall(env, projectId, '/feedback/status', {
				id: feedbackId,
				status,
			});
			return { feedback: publicFeedback(result.feedback as Record<string, unknown>) };
		},
	);
}

function checkTransportOrigin(request: Request, corsOrigins: string | undefined): Response | null {
	let requestUrl: URL;
	try {
		requestUrl = new URL(request.url);
	} catch {
		return Response.json({ error: 'invalid_request_host' }, { status: 403 });
	}
	const hostHeader = request.headers.get('Host');
	if (hostHeader) {
		if (
			hostHeader.includes('@') ||
			/[\s,/?#]/.test(hostHeader) ||
			hostHeader.toLowerCase() !== requestUrl.host.toLowerCase()
		) {
			return Response.json({ error: 'invalid_request_host' }, { status: 403 });
		}
	}
	const originHeader = request.headers.get('Origin');
	if (originHeader === null) return null;
	let origin: URL;
	try {
		origin = new URL(originHeader);
		if (
			(origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
			origin.origin !== originHeader
		) {
			return Response.json({ error: 'origin_not_allowed' }, { status: 403 });
		}
	} catch {
		return Response.json({ error: 'origin_not_allowed' }, { status: 403 });
	}
	const allowedOrigins = (corsOrigins ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (origin.origin !== requestUrl.origin && !allowedOrigins.includes(origin.origin)) {
		return Response.json({ error: 'origin_not_allowed' }, { status: 403 });
	}
	return null;
}

mcpRoutes.all('/:slug/mcp', async (c) => {
	const request = c.req.raw;
	const token = extractBearerToken(c.req.header('Authorization'));
	if (!token?.startsWith('wst_')) {
		await request.body?.cancel().catch(() => {});
		return c.json({ error: 'api_token_required' }, 401);
	}
	const originFailure = checkTransportOrigin(request, c.env.CORS_ORIGINS);
	if (originFailure) {
		await request.body?.cancel().catch(() => {});
		return originFailure;
	}
	if (request.method !== 'POST' && request.method !== 'GET') {
		await request.body?.cancel().catch(() => {});
		return c.json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, POST' });
	}
	if (request.method === 'POST') {
		const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
		if (contentType !== 'application/json') {
			await request.body?.cancel().catch(() => {});
			return c.json({ error: 'unsupported_content_type' }, 415);
		}
	}
	const auth = c.get('auth');
	if (!auth) return c.json({ error: 'unauthorized' }, 401);
	const access = await getProjectWithAccess(c, c.req.param('slug'));
	if (access instanceof Response) {
		await request.body?.cancel().catch(() => {});
		return access;
	}
	let parsedBody: unknown;
	if (request.method === 'POST') {
		try {
			const body = await readRequestBody(request, 32 * 1024);
			if (body.tooLarge) return c.json({ error: 'payload_too_large' }, 413);
			parsedBody = JSON.parse(body.text);
		} catch {
			return c.json(
				{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
				400,
			);
		}
		if (Array.isArray(parsedBody)) {
			return c.json(
				{
					jsonrpc: '2.0',
					id: null,
					error: { code: -32600, message: 'Batch messages are not supported' },
				},
				400,
			);
		}
	}
	const handler = createMcpHandler(
		() => {
			const server = new McpServer({ name: 'Workers Sentinel', version: '0.2.0' });
			registerTools(server, c.env, access.project.id, auth);
			return server;
		},
		{ legacy: 'stateless', maxRequestBodySize: 32 * 1024 },
	);
	return handler.fetch(request, {
		parsedBody,
		authInfo: {
			token,
			clientId: 'workers-sentinel-api-token',
			scopes: [],
			extra: { userId: auth.user.id, projectId: access.project.id },
		},
	});
});
