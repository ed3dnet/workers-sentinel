export interface FeedbackConnection {
	baseUrl: string;
	projectId: string;
	publicKey: string;
}

export interface ConnectionOptions {
	dsn?: string;
	serverUrl?: string;
	projectId?: string;
	publicKey?: string;
}

export function resolveConnection(options: ConnectionOptions): FeedbackConnection {
	if (options.dsn) {
		let dsn: URL;
		try {
			dsn = new URL(options.dsn);
		} catch {
			throw new Error('The feedback DSN must be a valid absolute URL.');
		}
		if (!['http:', 'https:'].includes(dsn.protocol) || dsn.password || dsn.search || dsn.hash) {
			throw new Error(
				'The feedback DSN must be an HTTP(S) URL without password, query, or fragment.',
			);
		}
		let publicKey: string;
		let pathParts: string[];
		try {
			publicKey = decodeURIComponent(dsn.username);
			pathParts = dsn.pathname.split('/').filter(Boolean).map(decodeURIComponent);
		} catch {
			throw new Error('The feedback DSN contains invalid percent-encoding.');
		}
		const projectId = pathParts.pop();
		if (!publicKey || !projectId)
			throw new Error('The feedback DSN must contain a public key and project ID.');
		// Accept both the usual Sentry-style /{projectId} path and API-shaped
		// /prefix/api/{projectId} paths without duplicating /api on submission.
		if (pathParts.at(-1)?.toLowerCase() === 'api') pathParts.pop();
		const prefix = pathParts.length ? `/${pathParts.map(encodeURIComponent).join('/')}` : '';
		return { baseUrl: `${dsn.origin}${prefix}`, projectId, publicKey };
	}

	if (!options.serverUrl || !options.projectId || !options.publicKey) {
		throw new Error('Provide either dsn or serverUrl, projectId, and publicKey.');
	}

	let baseUrl: URL;
	try {
		baseUrl = new URL(options.serverUrl);
	} catch {
		throw new Error('serverUrl must be a valid absolute URL.');
	}
	if (baseUrl.username || baseUrl.password || !['http:', 'https:'].includes(baseUrl.protocol)) {
		throw new Error('serverUrl must be an HTTP(S) URL without embedded credentials.');
	}
	const basePath = baseUrl.pathname.replace(/\/$/, '').replace(/\/api$/i, '');
	return {
		baseUrl: baseUrl.origin + basePath,
		projectId: options.projectId,
		publicKey: options.publicKey,
	};
}

export function serializeMetadata(value: unknown, maxBytes: number): string | undefined {
	if (value === undefined) return undefined;
	try {
		if (!isStrictJsonValue(value)) throw new Error('Metadata is not strict JSON data.');
		const serialized = JSON.stringify(value);
		if (typeof serialized !== 'string') throw new Error('Metadata is not JSON serializable.');
		if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
			throw new Error(`Metadata exceeds the ${maxBytes}-byte limit.`);
		}
		return serialized;
	} catch (error) {
		if (error instanceof Error && error.message.includes('limit')) throw error;
		throw new Error('Metadata must contain only strict, bounded JSON data.');
	}
}

function isStrictJsonValue(value: unknown, depth = 0): boolean {
	if (depth > 5) return false;
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (Array.isArray(value)) {
		if (value.length > 100) return false;
		for (let index = 0; index < value.length; index++) {
			if (!Object.hasOwn(value, index) || !isStrictJsonValue(value[index], depth + 1)) return false;
		}
		return Reflect.ownKeys(value).every(
			(key) =>
				key === 'length' ||
				(typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length),
		);
	}
	if (typeof value !== 'object') return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const keys = Reflect.ownKeys(value);
	if (keys.length > 100 || keys.some((key) => typeof key !== 'string' || key.length > 100))
		return false;
	for (const key of keys as string[]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !('value' in descriptor)) return false;
		if (!isStrictJsonValue(descriptor.value, depth + 1)) return false;
	}
	return true;
}

export function boundedNumber(
	value: number | undefined,
	fallback: number,
	min: number,
	max: number,
): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}
