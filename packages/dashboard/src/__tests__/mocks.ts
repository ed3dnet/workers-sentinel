import { vi } from 'vitest';

/**
 * Shared, resettable mocks for the API client (`../api/client`) and the
 * WebAuthn browser boundary (`@simplewebauthn/browser`). Each test file
 * installs these via `vi.mock(..., () => import('./mocks'))` and configures
 * per-route behavior through `mockApi`.
 */

export class MockApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export type RouteHandler = (body?: unknown) => unknown;

export interface MockApiState {
	get: Map<string, RouteHandler>;
	post: Map<string, RouteHandler>;
	delete: Map<string, RouteHandler>;
	calls: Array<{ method: 'get' | 'post' | 'delete'; url: string; body?: unknown }>;
}

export const mockApi: MockApiState = {
	get: new Map(),
	post: new Map(),
	delete: new Map(),
	calls: [],
};

function dispatch(method: 'get' | 'post' | 'delete', url: string, body?: unknown): unknown {
	mockApi.calls.push({ method, url, body });
	const handler = mockApi[method].get(url);
	if (!handler) {
		throw new MockApiError(`No mock for ${method.toUpperCase()} ${url}`, 500, 'not_mocked');
	}
	const result = handler(body);
	if (result instanceof MockApiError) throw result;
	return result;
}

export const api = {
	get: vi.fn((url: string) => Promise.resolve(dispatch('get', url))),
	post: vi.fn((url: string, body?: unknown) => Promise.resolve(dispatch('post', url, body))),
	patch: vi.fn((url: string, body?: unknown) =>
		Promise.resolve(dispatch('patch' as never, url, body)),
	),
	delete: vi.fn((url: string) => Promise.resolve(dispatch('delete', url))),
};

export const ApiError = MockApiError;

// @simplewebauthn/browser boundary — tests resolve/reject these per scenario
export const startRegistration = vi.fn();
export const startAuthentication = vi.fn();

export function resetMocks(): void {
	mockApi.get.clear();
	mockApi.post.clear();
	mockApi.delete.clear();
	mockApi.calls.length = 0;
	try {
		globalThis.localStorage?.clear();
	} catch {
		// No localStorage in this context (guarded; happy-dom provides it)
	}
	vi.clearAllMocks();
}

/** Route a mocked URL; handlers may return data or throw a MockApiError. */
export function onGet(url: string, handler: RouteHandler): void {
	mockApi.get.set(url, handler);
}
export function onPost(url: string, handler: RouteHandler): void {
	mockApi.post.set(url, handler);
}
export function onDelete(url: string, handler: RouteHandler): void {
	mockApi.delete.set(url, handler);
}
