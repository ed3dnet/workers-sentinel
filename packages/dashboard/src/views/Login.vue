<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = useRouter();
const authStore = useAuthStore();

const email = ref('');
const password = ref('');
const passkeyBusy = ref(false);
const passkeyError = ref<string | null>(null);

async function handleSubmit() {
	const success = await authStore.login(email.value, password.value);
	if (success) {
		router.push('/');
	}
}

/** Single-step usernameless sign-in: no email field involved. */
async function handlePasskey() {
	passkeyBusy.value = true;
	passkeyError.value = null;
	try {
		await authStore.loginWithPasskey();
		router.push('/');
	} catch (err) {
		// Browser-ceremony failures (no matching passkey, user cancel) get the
		// friendly message; server errors surface their own message.
		const isServerError = typeof err === 'object' && err !== null && 'status' in err;
		passkeyError.value = isServerError
			? err instanceof Error
				? err.message
				: 'Passkey sign-in failed'
			: 'No passkey found for this site — try email sign-in or register one after signing in.';
	} finally {
		passkeyBusy.value = false;
	}
}
</script>

<template>
	<div class="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full space-y-8">
			<div>
				<div class="mx-auto w-12 h-12 bg-primary-500 rounded-xl flex items-center justify-center">
					<span class="text-2xl font-bold text-white">S</span>
				</div>
				<h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
					Sign in to Sentinel
				</h2>
				<p class="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
					Or
					<RouterLink to="/register" class="font-medium text-primary-600 hover:text-primary-500">
						create a new account
					</RouterLink>
				</p>
			</div>

			<form class="mt-8 space-y-6" @submit.prevent="handleSubmit">
				<button
					type="button"
					class="btn btn-primary w-full"
					:disabled="passkeyBusy"
					data-testid="passkey-login-button"
					@click="handlePasskey"
				>
					{{ passkeyBusy ? 'Waiting for passkey…' : 'Sign in with a passkey' }}
				</button>
				<p class="text-center text-xs text-gray-500 dark:text-gray-400">
					No email needed — use your fingerprint, face, or security key
				</p>
				<div
					v-if="passkeyError"
					class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
					data-testid="passkey-login-error"
				>
					{{ passkeyError }}
				</div>

				<div class="relative">
					<div class="absolute inset-0 flex items-center">
						<span class="w-full border-t border-gray-300 dark:border-gray-600" />
					</div>
					<div class="relative flex justify-center text-sm">
						<span class="bg-gray-50 dark:bg-gray-900 px-2 text-gray-500 dark:text-gray-400">
							or sign in with email
						</span>
					</div>
				</div>

				<div v-if="authStore.error" class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm">
					{{ authStore.error }}
				</div>

				<div class="space-y-4">
					<div>
						<label for="email" class="label">Email address</label>
						<input
							id="email"
							v-model="email"
							type="email"
							autocomplete="email"
							required
							class="input"
							placeholder="you@example.com"
						/>
					</div>

					<div>
						<label for="password" class="label">Password</label>
						<input
							id="password"
							v-model="password"
							type="password"
							autocomplete="current-password"
							required
							class="input"
							placeholder="••••••••"
						/>
					</div>
				</div>

				<button type="submit" :disabled="authStore.loading" class="btn btn-primary w-full">
					<span v-if="authStore.loading">Signing in...</span>
					<span v-else>Sign in</span>
				</button>
			</form>
		</div>
	</div>
</template>
