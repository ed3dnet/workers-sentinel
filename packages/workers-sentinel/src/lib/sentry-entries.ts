/**
 * Sentry Event `entries` for the /api/0 serializer, built from the stored
 * raw SDK event. SDKs send snake_case interfaces (`exception.values`,
 * `lineno`, `in_app`, `pre_context`/`context_line`/`post_context`, …);
 * Sentry's API serializes them as typed entries with camelCase frames
 * (`lineNo`, `inApp`, `context: [[line, text], …]`). Sentry clients — the
 * official MCP server's stack-trace, breadcrumb and issue-detail tools —
 * read only these entries, never the raw interfaces.
 *
 * Input is untrusted stored JSON: every field is type-checked and anything
 * malformed is dropped rather than echoed in a shape clients would reject.
 * Entry order follows Sentry: exception, stacktrace, threads, message,
 * breadcrumbs, request.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
	return typeof value === 'boolean' ? value : null;
}

/** `{values: [...]}` or a bare array (both appear in SDK payloads). */
function valuesOf(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (isObject(value) && Array.isArray(value.values)) return value.values;
	return [];
}

/** `pre_context` / `context_line` / `post_context` → `[[lineNo, text], …]`. */
function frameContext(frame: Json, lineNo: number | null): Array<[number, string]> {
	const contextLine = str(frame.context_line);
	if (lineNo === null || contextLine === null) return [];
	const pre = Array.isArray(frame.pre_context) ? frame.pre_context : [];
	const post = Array.isArray(frame.post_context) ? frame.post_context : [];
	const lines: Array<[number, string]> = [];
	pre.forEach((text, i) => {
		if (typeof text === 'string') lines.push([lineNo - pre.length + i, text]);
	});
	lines.push([lineNo, contextLine]);
	post.forEach((text, i) => {
		if (typeof text === 'string') lines.push([lineNo + 1 + i, text]);
	});
	return lines;
}

function serializeFrame(raw: unknown): Json | null {
	if (!isObject(raw)) return null;
	const lineNo = num(raw.lineno);
	return {
		filename: str(raw.filename),
		absPath: str(raw.abs_path),
		module: str(raw.module),
		package: str(raw.package),
		platform: str(raw.platform),
		instructionAddr: str(raw.instruction_addr),
		symbolAddr: str(raw.symbol_addr),
		function: str(raw.function),
		rawFunction: str(raw.raw_function),
		symbol: str(raw.symbol),
		context: frameContext(raw, lineNo),
		lineNo,
		colNo: num(raw.colno),
		inApp: bool(raw.in_app) ?? false,
		trust: null,
		errors: null,
		lock: null,
		sourceLink: null,
		vars: isObject(raw.vars) ? raw.vars : null,
	};
}

/** Raw `stacktrace` → Sentry's serialized stack trace, or null. */
function serializeStacktrace(raw: unknown): Json | null {
	if (!isObject(raw) || !Array.isArray(raw.frames)) return null;
	const frames = raw.frames.map(serializeFrame).filter((f): f is Json => f !== null);
	if (frames.length === 0) return null;
	return {
		frames,
		framesOmitted: null,
		registers: isObject(raw.registers) ? raw.registers : null,
		hasSystemFrames: frames.some((frame) => frame.inApp !== true),
	};
}

function serializeException(raw: unknown): Json | null {
	if (!isObject(raw)) return null;
	const mechanism = isObject(raw.mechanism)
		? {
				type: str(raw.mechanism.type),
				handled: bool(raw.mechanism.handled),
				synthetic: bool(raw.mechanism.synthetic),
				description: str(raw.mechanism.description),
				data: isObject(raw.mechanism.data) ? raw.mechanism.data : null,
			}
		: null;
	return {
		type: str(raw.type),
		value: str(raw.value),
		module: str(raw.module),
		mechanism,
		threadId: num(raw.thread_id) ?? str(raw.thread_id),
		stacktrace: serializeStacktrace(raw.stacktrace),
		rawStacktrace: null,
	};
}

function serializeThread(raw: unknown): Json | null {
	if (!isObject(raw)) return null;
	return {
		id: num(raw.id) ?? str(raw.id),
		name: str(raw.name),
		current: bool(raw.current),
		crashed: bool(raw.crashed),
		state: str(raw.state),
		stacktrace: serializeStacktrace(raw.stacktrace),
		rawStacktrace: null,
	};
}

/** Breadcrumb timestamps arrive as RFC 3339 strings or unix seconds. */
function isoTimestamp(value: unknown): string | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const date = new Date(value * 1000);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	if (typeof value === 'string') {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	return null;
}

function serializeBreadcrumb(raw: unknown): Json | null {
	if (!isObject(raw)) return null;
	return {
		type: str(raw.type) ?? 'default',
		category: str(raw.category),
		level: str(raw.level) ?? 'info',
		message: str(raw.message),
		data: isObject(raw.data) ? raw.data : null,
		timestamp: isoTimestamp(raw.timestamp),
		event_id: str(raw.event_id),
	};
}

/**
 * Headers/query/cookies → Sentry's sorted `[[key, value], …]` pairs. SDKs
 * send objects or pair arrays; a string is accepted only where the protocol
 * allows one (`query_string`, a `Cookie`-style `cookies` string).
 */
function pairs(
	raw: unknown,
	stringForm: 'query' | 'cookie' | null = null,
): Array<[string, string]> {
	const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
	let entries: Array<[string, string]> = [];
	if (Array.isArray(raw)) {
		entries = raw
			.filter(
				(pair): pair is [string, unknown] =>
					Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string',
			)
			.map(([key, value]) => [key, text(value)]);
	} else if (isObject(raw)) {
		entries = Object.entries(raw).map(([key, value]) => [key, text(value)]);
	} else if (typeof raw === 'string' && raw !== '' && stringForm === 'query') {
		entries = [...new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw)];
	} else if (typeof raw === 'string' && raw !== '' && stringForm === 'cookie') {
		entries = raw
			.split(';')
			.map((part) => part.trim())
			.filter((part) => part !== '')
			.map((part) => {
				const eq = part.indexOf('=');
				return eq < 0 ? [part, ''] : [part.slice(0, eq), part.slice(eq + 1)];
			});
	}
	return entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** An absolute http(s) URL with its query and fragment split out, or null. */
function splitUrl(raw: unknown): { url: string; query: string; fragment: string } | null {
	if (typeof raw !== 'string') return null;
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
	const query = parsed.search.slice(1);
	const fragment = parsed.hash.slice(1);
	parsed.search = '';
	parsed.hash = '';
	return { url: parsed.toString(), query, fragment };
}

function serializeRequest(raw: unknown): Json | null {
	if (!isObject(raw)) return null;
	const split = splitUrl(raw.url);
	const queryString =
		raw.query_string !== undefined && raw.query_string !== null
			? raw.query_string
			: (split?.query ?? '');
	const headers = pairs(raw.headers);
	const contentType = headers.find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? null;
	return {
		url: split?.url ?? null,
		method: str(raw.method),
		query: pairs(queryString, 'query'),
		fragment: split?.fragment || null,
		data: raw.data ?? null,
		headers,
		cookies: pairs(raw.cookies, 'cookie'),
		env: isObject(raw.env) ? raw.env : null,
		inferredContentType: contentType,
	};
}

/** The `message` entry: from `logentry`, else a string or object `message`. */
function serializeMessage(rawEvent: Json): Json | null {
	const source = isObject(rawEvent.logentry) ? rawEvent.logentry : rawEvent.message;
	if (typeof source === 'string') {
		return source === '' ? null : { formatted: source, message: null, params: null };
	}
	if (!isObject(source)) return null;
	const formatted = str(source.formatted) ?? str(source.message);
	if (formatted === null) return null;
	return {
		formatted,
		message: str(source.message),
		params: Array.isArray(source.params) || isObject(source.params) ? source.params : null,
	};
}

/** The raw event's interfaces as Sentry `entries` (empty ones omitted). */
export function serializeEventEntries(rawEvent: Json): Json[] {
	const entries: Json[] = [];

	const exceptions = valuesOf(rawEvent.exception)
		.map(serializeException)
		.filter((value): value is Json => value !== null);
	if (exceptions.length > 0) {
		entries.push({
			type: 'exception',
			data: {
				values: exceptions,
				excOmitted: null,
				hasSystemFrames: exceptions.some(
					(exception) =>
						(exception.stacktrace as { hasSystemFrames?: boolean } | null)?.hasSystemFrames ===
						true,
				),
			},
		});
	}

	const stacktrace = serializeStacktrace(rawEvent.stacktrace);
	if (stacktrace) {
		entries.push({ type: 'stacktrace', data: stacktrace });
	}

	const threads = valuesOf(rawEvent.threads)
		.map(serializeThread)
		.filter((value): value is Json => value !== null);
	if (threads.length > 0) {
		entries.push({ type: 'threads', data: { values: threads } });
	}

	const message = serializeMessage(rawEvent);
	if (message) {
		entries.push({ type: 'message', data: message });
	}

	const breadcrumbs = valuesOf(rawEvent.breadcrumbs)
		.map(serializeBreadcrumb)
		.filter((value): value is Json => value !== null);
	if (breadcrumbs.length > 0) {
		entries.push({ type: 'breadcrumbs', data: { values: breadcrumbs } });
	}

	const request = serializeRequest(rawEvent.request);
	if (request) {
		entries.push({ type: 'request', data: request });
	}

	return entries;
}
