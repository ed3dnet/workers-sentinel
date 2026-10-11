class ApiError extends Error {
	constructor(
		message: string,
		public status: number,
		public code?: string,
		/** The full parsed error body (carries extra fields like the owns_projects list). */
		public body?: Record<string, unknown>,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

function getToken(): string | null {
	return localStorage.getItem('token');
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};

	const token = getToken();
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const response = await fetch(url, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	});

	const data = await response.json();

	if (!response.ok) {
		const body =
			typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : undefined;
		const message =
			(typeof body?.message === 'string' && body.message) ||
			(typeof body?.error === 'string' && body.error) ||
			'Request failed';
		throw new ApiError(
			message,
			response.status,
			typeof body?.error === 'string' ? body.error : undefined,
			body,
		);
	}

	return data;
}

export const api = {
	get: <T>(url: string) => request<T>('GET', url),
	post: <T>(url: string, body: unknown) => request<T>('POST', url, body),
	put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
	patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
	delete: <T>(url: string) => request<T>('DELETE', url),
};

export { ApiError };
