import type {
	PublicKeyCredentialCreationOptionsJSON,
	PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { api } from '../api/client';

export interface User {
	id: string;
	email: string;
	name: string;
	role: 'admin' | 'member';
	createdAt: string;
	updatedAt: string;
}

export interface PasskeyCredential {
	id: string;
	name: string;
	createdAt: string;
	lastUsedAt: string | null;
}

interface AuthResponse {
	user: User;
	token: string;
	hasPasskey?: boolean;
}

interface MeResponse {
	user: User;
	hasPasskey?: boolean;
}

interface PasskeyRegisterOptionsResponse {
	options: PublicKeyCredentialCreationOptionsJSON;
	ceremonyId: string;
}

interface PasskeyLoginOptionsResponse {
	options: PublicKeyCredentialRequestOptionsJSON;
	ceremonyId: string;
}

export const useAuthStore = defineStore('auth', () => {
	const user = ref<User | null>(null);
	const token = ref<string | null>(localStorage.getItem('token'));
	const initialized = ref(false);
	const loading = ref(false);
	const error = ref<string | null>(null);

	// Passkey state; kept current at every auth transition. The nag
	// dismissal is in-memory only (never sessionStorage/localStorage) so a
	// reload, a fresh login, or an account switch always re-prompts.
	const hasPasskey = ref(false);
	const dismissedForThisVisit = ref(false);

	const isAuthenticated = computed(() => !!user.value && !!token.value);
	const isAdmin = computed(() => user.value?.role === 'admin');

	function applyAuth(response: AuthResponse) {
		user.value = response.user;
		token.value = response.token;
		hasPasskey.value = response.hasPasskey ?? false;
		dismissedForThisVisit.value = false;
		localStorage.setItem('token', response.token);
	}

	async function checkAuth() {
		if (!token.value) {
			initialized.value = true;
			return;
		}

		try {
			const response = await api.get<MeResponse>('/api/auth/me');
			user.value = response.user;
			hasPasskey.value = response.hasPasskey ?? false;
			dismissedForThisVisit.value = false;
		} catch {
			// Token is invalid, clear it
			await logout();
		} finally {
			initialized.value = true;
		}
	}

	async function register(email: string, password: string, name: string) {
		loading.value = true;
		error.value = null;

		try {
			const response = await api.post<AuthResponse>('/api/auth/register', {
				email,
				password,
				name,
			});
			applyAuth(response);
			return true;
		} catch (err) {
			error.value = err instanceof Error ? err.message : 'Registration failed';
			return false;
		} finally {
			loading.value = false;
		}
	}

	async function login(email: string, password: string) {
		loading.value = true;
		error.value = null;

		try {
			const response = await api.post<AuthResponse>('/api/auth/login', { email, password });
			applyAuth(response);
			return true;
		} catch (err) {
			error.value = err instanceof Error ? err.message : 'Login failed';
			return false;
		} finally {
			loading.value = false;
		}
	}

	/**
	 * Usernameless passkey sign-in. Throws on failure so the caller can
	 * distinguish browser-ceremony failures (no credential, user cancelled)
	 * from server errors.
	 */
	async function loginWithPasskey() {
		const optionsResponse = await api.post<PasskeyLoginOptionsResponse>(
			'/api/auth/webauthn/login/options',
			{},
		);
		const response = await startAuthentication({ optionsJSON: optionsResponse.options });
		const result = await api.post<AuthResponse>('/api/auth/webauthn/verify/login', {
			ceremonyId: optionsResponse.ceremonyId,
			response,
		});
		applyAuth(result);
	}

	/** Register a new passkey for the signed-in user with a descriptive name. */
	async function registerPasskey(name: string) {
		const optionsResponse = await api.post<PasskeyRegisterOptionsResponse>(
			'/api/auth/webauthn/register/options',
			{},
		);
		const response = await startRegistration({ optionsJSON: optionsResponse.options });
		await api.post('/api/auth/webauthn/verify/register', {
			ceremonyId: optionsResponse.ceremonyId,
			name,
			response,
		});
		hasPasskey.value = true;
		dismissedForThisVisit.value = false;
	}

	async function listPasskeys(): Promise<PasskeyCredential[]> {
		const response = await api.get<{ credentials: PasskeyCredential[] }>(
			'/api/auth/webauthn/credentials',
		);
		return response.credentials;
	}

	async function deletePasskey(credentialId: string) {
		await api.post('/api/auth/webauthn/credentials/delete', { credentialId });
		const remaining = await listPasskeys();
		hasPasskey.value = remaining.length > 0;
		if (remaining.length === 0) {
			// The nag must reappear even within the same visit
			dismissedForThisVisit.value = false;
		}
	}

	/** Change password; the server revokes all sessions, so log out locally. */
	async function changePassword(currentPassword: string, newPassword: string) {
		await api.post('/api/auth/change-password', { currentPassword, newPassword });
		await logout();
	}

	function dismissPasskeyNag() {
		dismissedForThisVisit.value = true;
	}

	async function logout() {
		try {
			await api.post('/api/auth/logout', {});
		} catch {
			// Ignore errors
		}

		user.value = null;
		token.value = null;
		hasPasskey.value = false;
		dismissedForThisVisit.value = false;
		localStorage.removeItem('token');
	}

	return {
		user,
		token,
		initialized,
		loading,
		error,
		isAuthenticated,
		isAdmin,
		hasPasskey,
		dismissedForThisVisit,
		checkAuth,
		register,
		login,
		loginWithPasskey,
		registerPasskey,
		listPasskeys,
		deletePasskey,
		changePassword,
		dismissPasskeyNag,
		logout,
	};
});
