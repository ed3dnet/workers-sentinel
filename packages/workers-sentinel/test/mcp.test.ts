import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { authFetch, createTestProject, createTestUser, sendTestEvent } from './utils';

const feedbackPng = new Uint8Array([
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
	0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 0, 0, 3, 1, 1, 0,
	201, 254, 146, 239, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

async function createApiToken(session: string, expiresAt?: string) {
	const response = await authFetch(session, 'http://localhost/api/auth/tokens', {
		method: 'POST',
		body: JSON.stringify({ name: 'MCP test token', expiresAt }),
	});
	expect(response.ok).toBe(true);
	return (await response.json()) as { rawToken: string; token: { id: string } };
}

function mcpRequest(
	url: string,
	token: string,
	body: unknown,
	extraHeaders: Record<string, string> = {},
) {
	return SELF.fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
}

async function rpc(response: Response) {
	const text = await response.text();
	if (response.headers.get('content-type')?.includes('text/event-stream')) {
		const match = text.match(/^data: (.+)$/m);
		if (!match) throw new Error(`MCP response contained no data event: ${text}`);
		return JSON.parse(match[1]);
	}
	return JSON.parse(text);
}

async function callTool(url: string, token: string, name: string, args: unknown) {
	const response = await mcpRequest(url, token, {
		jsonrpc: '2.0',
		id: crypto.randomUUID(),
		method: 'tools/call',
		params: { name, arguments: args },
	});
	return { response, body: await rpc(response) };
}

describe('project-scoped MCP endpoint', () => {
	it('accepts its returned cursor when sorting long multiline exception titles', async () => {
		const user = await createTestUser({
			email: `mcp-long-title-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Cursor User',
		});
		const project = await createTestProject(user.token!, {
			name: `Long title ${crypto.randomUUID()}`,
		});
		const { rawToken: token } = await createApiToken(user.token!);
		for (const prefix of ['A', 'B']) {
			await sendTestEvent(project.id, project.publicKey, {
				exception: { type: `${prefix} Error\nNext line${'x'.repeat(499)}`, value: 'v'.repeat(100) },
			});
		}
		const url = `http://localhost/api/projects/${project.slug}/mcp`;
		const first = await callTool(url, token, 'list_issues', { sort: 'title', limit: 1 });
		expect(first.body.result.isError).not.toBe(true);
		const page = JSON.parse(first.body.result.content[0].text);
		expect(page.nextCursor.length).toBeGreaterThan(300);
		expect(page.nextCursor).toContain('\n');
		const next = await callTool(url, token, 'list_issues', {
			sort: 'title',
			limit: 1,
			cursor: page.nextCursor,
		});
		expect(next.body.result.isError).not.toBe(true);
		const nextPage = JSON.parse(next.body.result.content[0].text);
		expect(nextPage.issues).toHaveLength(1);
		expect(nextPage.issues[0].id).not.toBe(page.issues[0].id);
		expect(nextPage.hasMore).toBe(false);
	});
	it('initializes, lists tools and performs feedback and issue triage within the URL project', async () => {
		const user = await createTestUser({
			email: `mcp-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'MCP User',
		});
		const project = await createTestProject(user.token!, { name: `MCP ${crypto.randomUUID()}` });
		const { rawToken: token } = await createApiToken(user.token!);
		const event = await sendTestEvent(project.id, project.publicKey, {
			message: 'MCP issue example',
		});
		const init = await mcpRequest(`http://localhost/api/projects/${project.slug}/mcp`, token, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'test-client', version: '1.0.0' },
			},
		});
		expect(init.status).toBe(200);
		expect(init.headers.get('content-type')).toMatch(/application\/json|text\/event-stream/);
		expect((await rpc(init)).result.serverInfo).toMatchObject({
			name: 'Workers Sentinel',
			version: '0.2.0',
		});
		const initialized = await mcpRequest(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			{
				jsonrpc: '2.0',
				method: 'notifications/initialized',
			},
		);
		expect([200, 202, 204]).toContain(initialized.status);
		const initializedType = initialized.headers.get('content-type');
		if (initializedType) expect(initializedType).toMatch(/json|event-stream/);

		const listed = await mcpRequest(`http://localhost/api/projects/${project.slug}/mcp`, token, {
			jsonrpc: '2.0',
			id: 2,
			method: 'tools/list',
			params: {},
		});
		expect(listed.status).toBe(200);
		expect(listed.headers.get('content-type')).toMatch(/application\/json|text\/event-stream/);
		const toolNames = (await rpc(listed)).result.tools.map((tool: { name: string }) => tool.name);
		expect(toolNames).toEqual([
			'list_issues',
			'get_issue',
			'list_issue_events',
			'list_issue_comments',
			'set_issue_status',
			'add_issue_comment',
			'snooze_issue',
			'unsnooze_issue',
			'list_feedback',
			'get_feedback',
			'get_feedback_screenshot',
			'set_feedback_status',
		]);
		expect(toolNames).not.toContain('delete_issue');

		const issueList = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'list_issues',
			{ query: 'MCP issue example', limit: 25 },
		);
		expect(issueList.response.status).toBe(200);
		const issuePayload = JSON.parse(issueList.body.result.content[0].text);
		expect(issuePayload.issues).toHaveLength(1);
		const issueId = issuePayload.issues[0].id;
		const issueDetail = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'get_issue',
			{ issueId },
		);
		expect(JSON.parse(issueDetail.body.result.content[0].text).issue.id).toBe(issueId);
		const issueEvents = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'list_issue_events',
			{ issueId, limit: 10 },
		);
		expect(JSON.parse(issueEvents.body.result.content[0].text).events).toHaveLength(1);

		const commented = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'add_issue_comment',
			{ issueId, body: 'Investigating through MCP' },
		);
		expect(commented.body.isError).not.toBe(true);
		const commentPayload = JSON.parse(commented.body.result.content[0].text).comment;
		expect(commentPayload).toMatchObject({
			body: 'Investigating through MCP',
			userName: 'MCP User',
		});
		const comments = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'list_issue_comments',
			{ issueId },
		);
		expect(JSON.parse(comments.body.result.content[0].text).comments).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: commentPayload.id, userId: user.id })]),
		);
		const status = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'set_issue_status',
			{ issueId, status: 'resolved' },
		);
		expect(JSON.parse(status.body.result.content[0].text).issue.status).toBe('resolved');
		const reopened = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'set_issue_status',
			{ issueId, status: 'unresolved' },
		);
		expect(JSON.parse(reopened.body.result.content[0].text).issue.status).toBe('unresolved');
		const ignored = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'set_issue_status',
			{ issueId, status: 'ignored' },
		);
		expect(JSON.parse(ignored.body.result.content[0].text).issue.status).toBe('ignored');
		const snooze = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'snooze_issue',
			{ issueId, duration: '1h' },
		);
		expect(snooze.body.isError).not.toBe(true);
		expect(JSON.parse(snooze.body.result.content[0].text).issue.snoozedUntil).toBeTruthy();
		const activityResponse = await SELF.fetch(
			`http://localhost/api/projects/${project.slug}/issues/${issueId}/activity`,
			{ headers: { Authorization: `Bearer ${user.token}` } },
		);
		expect(activityResponse.status).toBe(200);
		const activity = (await activityResponse.json()) as {
			activity: Array<{ userId: string; userName: string; type: string }>;
		};
		expect(activity.activity).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ userId: user.id, userName: 'MCP User', type: 'status_change' }),
				expect.objectContaining({ userId: user.id, userName: 'MCP User', type: 'comment' }),
			]),
		);
		const unsnooze = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'unsnooze_issue',
			{ issueId },
		);
		expect(unsnooze.body.isError).not.toBe(true);
		expect(JSON.parse(unsnooze.body.result.content[0].text).issue.snoozedUntil).toBeNull();
		const ignoredIssues = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'list_issues',
			{ status: 'ignored', limit: 100 },
		);
		expect(JSON.parse(ignoredIssues.body.result.content[0].text).issues).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: issueId, status: 'ignored' })]),
		);

		const notification = await SELF.fetch(
			`http://localhost/api/${project.id}/feedback?sentry_key=${project.publicKey}`,
			{
				method: 'POST',
				body: (() => {
					const data = new FormData();
					data.set(
						'metadata',
						JSON.stringify({
							description: 'MCP feedback report',
							pageUrl: 'https://example.com/settings',
							pageTitle: 'Settings',
							locator: '#save',
						}),
					);
					data.set('screenshot', new Blob([feedbackPng], { type: 'image/png' }), 'feedback.png');
					return data;
				})(),
			},
		);
		const feedbackId = ((await notification.json()) as { id: string }).id;
		const feedback = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'get_feedback',
			{ feedbackId },
		);
		const publicItem = JSON.parse(feedback.body.result.content[0].text).feedback;
		expect(publicItem.status).toBe('unresolved');
		expect(publicItem.screenshotKey).toBeUndefined();
		expect(JSON.parse(feedback.body.result.content[0].text).guidance).toMatch(
			/get_feedback_screenshot.*feedbackId.*retrieve and inspect it/,
		);
		const screenshot = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'get_feedback_screenshot',
			{ feedbackId },
		);
		expect(screenshot.response.status).toBe(200);
		expect(screenshot.body.result.content).toEqual([
			{ type: 'image', mimeType: 'image/png', data: btoa(String.fromCharCode(...feedbackPng)) },
		]);
		const withoutScreenshotForm = new FormData();
		withoutScreenshotForm.set(
			'metadata',
			JSON.stringify({
				description: 'MCP feedback without screenshot',
				pageUrl: 'https://example.com/settings',
				pageTitle: 'Settings',
				locator: '#save',
			}),
		);
		const withoutScreenshotResponse = await SELF.fetch(
			`http://localhost/api/${project.id}/feedback?sentry_key=${project.publicKey}`,
			{ method: 'POST', body: withoutScreenshotForm },
		);
		const withoutScreenshotId = ((await withoutScreenshotResponse.json()) as { id: string }).id;
		const feedbackWithoutScreenshot = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'get_feedback',
			{ feedbackId: withoutScreenshotId },
		);
		const feedbackWithoutScreenshotValue = JSON.parse(
			feedbackWithoutScreenshot.body.result.content[0].text,
		);
		expect(feedbackWithoutScreenshotValue.feedback.screenshotType).toBeNull();
		expect(feedbackWithoutScreenshotValue).not.toHaveProperty('guidance');
		const missingScreenshot = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'get_feedback_screenshot',
			{ feedbackId: withoutScreenshotId },
		);
		expect(missingScreenshot.body.result.isError).toBe(true);
		expect(missingScreenshot.body.result.content[0].text).toBe('screenshot_not_found');
		const resolved = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'set_feedback_status',
			{ feedbackId, status: 'resolved' },
		);
		expect(JSON.parse(resolved.body.result.content[0].text).feedback.status).toBe('resolved');
		const reopenedFeedback = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'set_feedback_status',
			{ feedbackId, status: 'unresolved' },
		);
		expect(JSON.parse(reopenedFeedback.body.result.content[0].text).feedback.status).toBe(
			'unresolved',
		);
		const feedbackList = await callTool(
			`http://localhost/api/projects/${project.slug}/mcp`,
			token,
			'list_feedback',
			{ status: 'unresolved', query: 'MCP feedback', limit: 10 },
		);
		const listedFeedback = JSON.parse(feedbackList.body.result.content[0].text).feedback;
		expect(listedFeedback).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: feedbackId })]),
		);
		for (const item of [publicItem, ...listedFeedback]) {
			expect(item).not.toHaveProperty('screenshotKey');
			expect(item).not.toHaveProperty('screenshot_key');
		}
		expect(event.id).toBeTruthy();
	});

	it('requires a valid API token on every request and masks foreign project items', async () => {
		const owner = await createTestUser({
			email: `mcp-owner-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Owner',
		});
		const foreign = await createTestUser({
			email: `mcp-foreign-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Foreign',
		});
		const project = await createTestProject(owner.token!, {
			name: `MCP private ${crypto.randomUUID()}`,
		});
		await sendTestEvent(project.id, project.publicKey, { message: 'owner issue stays unresolved' });
		const ownerIssueRows = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}/issues`,
		);
		const ownerIssueId = ((await ownerIssueRows.json()) as { issues: Array<{ id: string }> })
			.issues[0].id;
		const foreignProject = await createTestProject(foreign.token!, {
			name: `MCP foreign ${crypto.randomUUID()}`,
		});
		await sendTestEvent(foreignProject.id, foreignProject.publicKey, {
			message: 'foreign issue must stay private',
		});
		const foreignIssueList = await authFetch(
			foreign.token!,
			`http://localhost/api/projects/${foreignProject.slug}/issues`,
		);
		const foreignIssueId = ((await foreignIssueList.json()) as { issues: Array<{ id: string }> })
			.issues[0].id;
		const foreignFeedbackForm = new FormData();
		foreignFeedbackForm.set(
			'metadata',
			JSON.stringify({
				description: 'foreign feedback',
				pageUrl: 'https://foreign.example',
				pageTitle: 'Foreign',
				locator: '#foreign',
			}),
		);
		foreignFeedbackForm.set(
			'screenshot',
			new Blob([feedbackPng], { type: 'image/png' }),
			'foreign.png',
		);
		const foreignFeedbackResponse = await SELF.fetch(
			`http://localhost/api/${foreignProject.id}/feedback?sentry_key=${foreignProject.publicKey}`,
			{ method: 'POST', body: foreignFeedbackForm },
		);
		expect(foreignFeedbackResponse.status).toBe(201);
		const foreignFeedbackId = ((await foreignFeedbackResponse.json()) as { id: string }).id;
		const { rawToken: token, token: tokenRecord } = await createApiToken(owner.token!);
		const expiredToken = await createApiToken(owner.token!);
		const authState = env.AUTH_STATE.get(env.AUTH_STATE.idFromName('global'));
		const expiredAt = new Date(Date.now() - 86_400_000).toISOString();
		await authState.fetch(
			new Request('http://internal/test/set-api-token-expiration', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tokenId: expiredToken.token.id, expiresAt: expiredAt }),
			}),
		);
		const path = `http://localhost/api/projects/${project.slug}/mcp`;
		for (const bad of [undefined, owner.token, 'wst_invalid', expiredToken.rawToken]) {
			const headers: Record<string, string> = {
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json',
			};
			if (bad) headers.Authorization = `Bearer ${bad}`;
			for (const method of ['GET', 'POST']) {
				const response = await SELF.fetch(path, {
					method,
					headers,
					...(method === 'POST'
						? { body: JSON.stringify({ jsonrpc: '2.0', id: 'auth', method: 'tools/list' }) }
						: {}),
				});
				expect(response.status).toBe(401);
				if (method === 'POST')
					expect(await response.json()).toMatchObject({ error: expect.any(String) });
			}
		}
		const denied = await SELF.fetch(`http://localhost/api/projects/${foreignProject.slug}/mcp`, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
		});
		expect(denied.status).toBe(404);
		const foreignIssueRead = await callTool(path, token, 'get_issue', { issueId: foreignIssueId });
		expect(foreignIssueRead.body.error ?? foreignIssueRead.body.result?.isError).toBeTruthy();
		const foreignIssueUpdate = await callTool(path, token, 'set_issue_status', {
			issueId: foreignIssueId,
			status: 'resolved',
		});
		expect(foreignIssueUpdate.body.error ?? foreignIssueUpdate.body.result?.isError).toBeTruthy();
		const foreignIssueState = await authFetch(
			foreign.token!,
			`http://localhost/api/projects/${foreignProject.slug}/issues/${foreignIssueId}`,
		);
		expect(((await foreignIssueState.json()) as { issue: { status: string } }).issue.status).toBe(
			'unresolved',
		);
		const foreignFeedbackRead = await callTool(path, token, 'get_feedback', {
			feedbackId: foreignFeedbackId,
		});
		expect(foreignFeedbackRead.body.error ?? foreignFeedbackRead.body.result?.isError).toBeTruthy();
		const foreignFeedbackScreenshot = await callTool(path, token, 'get_feedback_screenshot', {
			feedbackId: foreignFeedbackId,
		});
		expect(
			foreignFeedbackScreenshot.body.error ?? foreignFeedbackScreenshot.body.result?.isError,
		).toBeTruthy();
		const foreignFeedbackUpdate = await callTool(path, token, 'set_feedback_status', {
			feedbackId: foreignFeedbackId,
			status: 'resolved',
		});
		expect(
			foreignFeedbackUpdate.body.error ?? foreignFeedbackUpdate.body.result?.isError,
		).toBeTruthy();
		const foreignFeedbackState = await authFetch(
			foreign.token!,
			`http://localhost/api/projects/${foreignProject.slug}/feedback/${foreignFeedbackId}`,
		);
		expect(
			((await foreignFeedbackState.json()) as { feedback: { status: string } }).feedback.status,
		).toBe('unresolved');
		const get = await SELF.fetch(path, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
		});
		expect(get.status).toBe(405);
		const liveInit = await mcpRequest(path, token, {
			jsonrpc: '2.0',
			id: 'before-revoke',
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'test', version: '1' },
			},
		});
		expect(liveInit.status).toBe(200);
		await authFetch(owner.token!, `http://localhost/api/auth/tokens/${tokenRecord.id}`, {
			method: 'DELETE',
		});
		const revoked = await SELF.fetch(path, {
			method: 'GET',
			headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
		});
		expect(revoked.status).toBe(401);
		const revokedMutation = await SELF.fetch(path, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 'after-revoke',
				method: 'tools/call',
				params: {
					name: 'set_issue_status',
					arguments: { issueId: ownerIssueId, status: 'resolved' },
				},
			}),
		});
		expect(revokedMutation.status).toBe(401);
		const ownerIssueAfterRevoke = await authFetch(
			owner.token!,
			`http://localhost/api/projects/${project.slug}/issues/${ownerIssueId}`,
		);
		expect(
			((await ownerIssueAfterRevoke.json()) as { issue: { status: string } }).issue.status,
		).toBe('unresolved');
	});

	it('rejects unsafe origins, malformed/batch JSON-RPC, unsupported content and invalid tool inputs', async () => {
		const user = await createTestUser({
			email: `mcp-transport-${crypto.randomUUID()}@example.com`,
			password: 'testpassword123',
			name: 'Transport User',
		});
		const project = await createTestProject(user.token!, {
			name: `MCP transport ${crypto.randomUUID()}`,
		});
		const { rawToken: token } = await createApiToken(user.token!);
		const url = `http://localhost/api/projects/${project.slug}/mcp`;
		const sameOrigin = await mcpRequest(
			url,
			token,
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					clientInfo: { name: 'test', version: '1' },
				},
			},
			{ Origin: 'http://localhost' },
		);
		expect(sameOrigin.status).toBe(200);
		const configured = await mcpRequest(
			url,
			token,
			{
				jsonrpc: '2.0',
				id: 2,
				method: 'tools/list',
				params: {},
			},
			{ Origin: 'https://listed.example' },
		);
		expect(configured.status).toBe(200);
		const protectedFeedbackForm = new FormData();
		protectedFeedbackForm.set(
			'metadata',
			JSON.stringify({
				description: 'must not be changed',
				pageUrl: 'https://protected.example',
				pageTitle: 'Protected',
				locator: '#protected',
			}),
		);
		const protectedFeedbackResponse = await SELF.fetch(
			`http://localhost/api/${project.id}/feedback?sentry_key=${project.publicKey}`,
			{ method: 'POST', body: protectedFeedbackForm },
		);
		const protectedFeedbackId = ((await protectedFeedbackResponse.json()) as { id: string }).id;
		for (const method of ['POST', 'GET']) {
			for (const origin of ['https://attacker.example', 'null', 'http://localhost/path']) {
				const denied = await SELF.fetch(url, {
					method,
					headers: {
						Authorization: `Bearer ${token}`,
						Origin: origin,
						Accept: 'application/json, text/event-stream',
						'Content-Type': 'application/json',
					},
					...(method === 'POST'
						? {
								body: JSON.stringify({
									jsonrpc: '2.0',
									id: 4,
									method: 'tools/call',
									params: {
										name: 'set_feedback_status',
										arguments: { feedbackId: protectedFeedbackId, status: 'resolved' },
									},
								}),
							}
						: {}),
				});
				expect(denied.status).toBe(403);
				expect(await denied.json()).toMatchObject({ error: expect.any(String) });
			}
		}
		for (const method of ['GET', 'POST']) {
			const badHost = await SELF.fetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: 'application/json, text/event-stream',
					'Content-Type': 'application/json',
					Host: 'wrong.example',
					Origin: 'http://localhost',
				},
				...(method === 'POST'
					? { body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }) }
					: {}),
			});
			expect(badHost.status).toBe(403);
		}
		const protectedFeedbackState = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/feedback/${protectedFeedbackId}`,
		);
		expect(
			((await protectedFeedbackState.json()) as { feedback: { status: string } }).feedback.status,
		).toBe('unresolved');
		const unsupported = await SELF.fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
			body: '{}',
		});
		expect(unsupported.status).toBe(415);
		const mutation = (feedbackId: string) => ({
			jsonrpc: '2.0',
			id: 10,
			method: 'tools/call',
			params: { name: 'set_feedback_status', arguments: { feedbackId, status: 'resolved' } },
		});
		const malformed = await SELF.fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: '{bad',
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({
			jsonrpc: '2.0',
			error: { code: -32700, message: expect.any(String) },
		});
		const batch = await SELF.fetch(url, {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify([
				mutation(protectedFeedbackId),
				{ jsonrpc: '2.0', id: 8, method: 'tools/list' },
			]),
		});
		expect(batch.status).toBe(400);
		expect(await batch.json()).toMatchObject({
			jsonrpc: '2.0',
			error: { code: -32600, message: 'Batch messages are not supported' },
		});
		const issueEvent = await sendTestEvent(project.id, project.publicKey, {
			message: 'validation target',
		});
		const issueRowsResponse = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues`,
		);
		const targetIssueId = ((await issueRowsResponse.json()) as { issues: Array<{ id: string }> })
			.issues[0].id;
		const invalidCalls = [
			['list_issues', { projectId: project.id }],
			['list_issues', { limit: 0 }],
			['list_issues', { limit: 101 }],
			['list_issues', { query: 'q'.repeat(201) }],
			['list_issues', { tags: ['a', 'b', 'c', 'd', 'e', 'f'] }],
			['list_issues', { cursor: 'c'.repeat(1025) }],
			['get_issue', { issueId: targetIssueId, projectId: project.id }],
			['add_issue_comment', { issueId: targetIssueId, body: '   ' }],
			['add_issue_comment', { issueId: targetIssueId, body: 'c'.repeat(2001) }],
			['add_issue_comment', { issueId: targetIssueId, body: 'valid', projectId: project.id }],
			['list_feedback', { status: 'deleted', limit: 5000 }],
			['list_feedback', { query: 'q'.repeat(201) }],
			['list_feedback', { cursor: 'c'.repeat(301) }],
		];
		for (const [name, args] of invalidCalls) {
			const invalid = await callTool(url, token, name as string, args);
			expect(invalid.response.status).toBe(200);
			expect(invalid.body.result?.isError).toBe(true);
			expect(invalid.body.result.content[0].text).toEqual(expect.any(String));
			expect(invalid.body.result.content[0].text.length).toBeGreaterThan(0);
		}
		const issueAfterInvalid = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/issues/${targetIssueId}`,
		);
		expect(((await issueAfterInvalid.json()) as { issue: { status: string } }).issue.status).toBe(
			'unresolved',
		);
		const feedbackAfterInvalid = await authFetch(
			user.token!,
			`http://localhost/api/projects/${project.slug}/feedback/${protectedFeedbackId}`,
		);
		expect(
			((await feedbackAfterInvalid.json()) as { feedback: { status: string } }).feedback.status,
		).toBe('unresolved');
		expect(issueEvent.id).toBeTruthy();
		const disallowedMethod = await SELF.fetch(url, {
			method: 'DELETE',
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(disallowedMethod.status).toBe(405);
	});
});
