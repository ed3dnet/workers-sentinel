export interface WebhookPayload {
	text: string;
	project: {
		id: string;
		name: string;
		slug: string;
	};
	issue: {
		id: string;
		title: string;
		level: string;
		culprit: string | null;
	};
	timestamp: string;
}

export function buildWebhookPayload(
	project: { id: string; name: string; slug: string },
	issue: { id: string; title: string; level: string; culprit: string | null },
): WebhookPayload {
	const levelEmoji: Record<string, string> = {
		fatal: '\u{1F480}',
		error: '\u{1F6A8}',
		warning: '\u26A0\uFE0F',
		info: '\u2139\uFE0F',
		debug: '\u{1F50D}',
	};
	const emoji = levelEmoji[issue.level] || '\u{1F6A8}';
	const culpritText = issue.culprit ? ` in ${issue.culprit}` : '';

	return {
		text: `${emoji} [${project.name}] New ${issue.level}: ${issue.title}${culpritText}`,
		project: {
			id: project.id,
			name: project.name,
			slug: project.slug,
		},
		issue: {
			id: issue.id,
			title: issue.title,
			level: issue.level,
			culprit: issue.culprit,
		},
		timestamp: new Date().toISOString(),
	};
}

const WEBHOOK_TIMEOUT_MS = 10000;

/**
 * Validate a webhook destination. Only https:// URLs whose hostname is not a
 * loopback/link-local/private literal are accepted. This is defense in depth:
 * Workers egress cannot reach RFC1918 space in production, but local dev under
 * workerd can, and redirects must also be refused (an attacker-controlled
 * redirect target is not re-validated by fetch).
 */
export function validateWebhookUrl(
	raw: string,
): { ok: true; url: URL } | { ok: false; reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: 'invalid URL' };
	}
	if (url.protocol !== 'https:') {
		return { ok: false, reason: 'only https URLs are allowed' };
	}
	const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (
		host === 'localhost' ||
		host.endsWith('.localhost') ||
		host.endsWith('.local') ||
		host.endsWith('.internal') ||
		/^127\./.test(host) ||
		/^0\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^169\.254\./.test(host) ||
		/^::1$/.test(host) ||
		/^f[cd][0-9a-f]{2}:/.test(host)
	) {
		return { ok: false, reason: 'webhook host must not be a private or loopback address' };
	}
	if (url.username || url.password) {
		return { ok: false, reason: 'credentials in webhook URL are not allowed' };
	}
	return { ok: true, url };
}

export async function sendWebhook(url: string, payload: WebhookPayload): Promise<void> {
	const validated = validateWebhookUrl(url);
	if (!validated.ok) {
		console.error(`Webhook delivery refused: ${validated.reason}`);
		return;
	}
	try {
		const response = await fetch(validated.url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			// Redirects are refused: a redirect target would bypass the
			// scheme/host validation above
			redirect: 'error',
			signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
		});
		if (!response.ok) {
			// Never read or log the target's response body: it can echo
			// attacker-controlled content into observability logs
			console.error(`Webhook delivery failed: ${response.status}`);
		} else {
			await response.body?.cancel();
		}
	} catch (error) {
		console.error(
			'Webhook delivery error:',
			error instanceof Error ? error.message.slice(0, 200) : 'unknown',
		);
	}
}
