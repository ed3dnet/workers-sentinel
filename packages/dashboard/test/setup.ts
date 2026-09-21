import { beforeEach } from 'vitest';
import { resetMocks } from '../src/__tests__/mocks';

// happy-dom (15.x) does not surface `localStorage` on globalThis or on its
// bare `window`, but the dashboard reads it as a bare global. Install an
// in-memory Storage whenever a real one is not present.
const memoryStorage = (): Storage => {
	const store = new Map<string, string>();
	return {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key: string) => (store.has(key) ? (store.get(key) ?? null) : null),
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		removeItem: (key: string) => {
			store.delete(key);
		},
		setItem: (key: string, value: string) => {
			store.set(key, String(value));
		},
	};
};

const existing =
	(globalThis as { localStorage?: Storage }).localStorage ??
	(globalThis.window as { localStorage?: Storage } | undefined)?.localStorage;
if (!existing) {
	(globalThis as { localStorage?: Storage }).localStorage = memoryStorage();
}

beforeEach(() => {
	resetMocks();
});
