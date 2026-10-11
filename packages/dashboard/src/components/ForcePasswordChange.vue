<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';

const authStore = useAuthStore();

const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const saving = ref(false);
const error = ref<string | null>(null);

async function submit() {
	error.value = null;

	if (newPassword.value.length < 8) {
		error.value = 'New password must be at least 8 characters';
		return;
	}
	if (newPassword.value !== confirmPassword.value) {
		error.value = 'New passwords do not match';
		return;
	}

	saving.value = true;
	try {
		// The server revokes every session on success; the store's
		// changePassword already logs out locally and clears the token.
		await authStore.changePassword(currentPassword.value, newPassword.value);
		// The router guard sends the (now anonymous) visitor to /login
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to change password';
		saving.value = false;
	}
}
</script>

<template>
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/80 backdrop-blur-sm"
		data-testid="force-password-change"
	>
		<div class="card p-8 w-full max-w-md">
			<div class="flex items-center space-x-3 mb-4">
				<div
					class="w-10 h-10 rounded-full bg-warning-100 dark:bg-warning-900/30 text-warning-700 dark:text-warning-300 flex items-center justify-center"
				>
					<svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
				</div>
				<h1 class="text-xl font-semibold text-gray-900 dark:text-white">
					Set a new password
				</h1>
			</div>

			<p class="text-sm text-gray-500 mb-6">
				Your account was created or reset by an administrator with a temporary password.
				Choose a new password to continue — everything else stays blocked until then.
			</p>

			<form class="space-y-4" @submit.prevent="submit">
				<div>
					<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
						Current password (the temporary one)
					</label>
					<input
						v-model="currentPassword"
						type="password"
						required
						autocomplete="current-password"
						class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						data-testid="force-password-current"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
						New password
					</label>
					<input
						v-model="newPassword"
						type="password"
						required
						autocomplete="new-password"
						class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						data-testid="force-password-new"
					/>
				</div>
				<div>
					<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
						Confirm new password
					</label>
					<input
						v-model="confirmPassword"
						type="password"
						required
						autocomplete="new-password"
						class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						data-testid="force-password-confirm"
					/>
				</div>

				<div
					v-if="error"
					class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
					data-testid="force-password-error"
				>
					{{ error }}
				</div>

				<button
					type="submit"
					class="btn btn-primary w-full"
					:disabled="saving || !currentPassword || !newPassword || !confirmPassword"
					data-testid="force-password-submit"
				>
					<span v-if="saving">Saving…</span>
					<span v-else>Set password and sign in again</span>
				</button>
			</form>
		</div>
	</div>
</template>
