/**
 * Streaming-capped JSON body reading, shared by the body-capped routes
 * (WebAuthn ceremonies, admin mutations). The cap is enforced DURING
 * streaming — the body is never buffered beyond the cap (early
 * Content-Length rejection is only an optimization; chunked bodies are
 * bounded chunk by chunk).
 */

export type CappedJson =
	| { ok: true; body: Record<string, unknown> }
	| { ok: false; response: Response };

export const bodyTooLarge = {
	error: 'body_too_large',
	message: 'Request body exceeds the size limit',
} as const;

export const invalidJsonBody = {
	error: 'invalid_json',
	message: 'Request body must be a valid JSON object',
} as const;

export async function readCappedJson(
	c: { req: { header: (name: string) => string | undefined; raw: Request } },
	maxBytes: number,
): Promise<CappedJson> {
	const declared = c.req.header('Content-Length');
	if (declared && Number(declared) > maxBytes) {
		await c.req.raw.body?.cancel().catch(() => undefined);
		return { ok: false, response: Response.json(bodyTooLarge, { status: 413 }) };
	}

	const reader = c.req.raw.body?.getReader();
	if (!reader) {
		return { ok: false, response: Response.json(invalidJsonBody, { status: 400 }) };
	}
	const chunks: Uint8Array[] = [];
	let received = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return { ok: false, response: Response.json(bodyTooLarge, { status: 413 }) };
		}
		chunks.push(value);
	}

	const assembled = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		assembled.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		const parsed = JSON.parse(new TextDecoder().decode(assembled)) as unknown;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { ok: false, response: Response.json(invalidJsonBody, { status: 400 }) };
		}
		return { ok: true, body: parsed as Record<string, unknown> };
	} catch {
		return { ok: false, response: Response.json(invalidJsonBody, { status: 400 }) };
	}
}
