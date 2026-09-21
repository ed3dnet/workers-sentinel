<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';

const authStore = useAuthStore();

const name = ref('');
const creating = ref(false);
const error = ref<string | null>(null);

const visible = computed(
	() => authStore.isAuthenticated && !authStore.hasPasskey && !authStore.dismissedForThisVisit,
);

async function createPasskey() {
	const trimmed = name.value.trim();
	if (!trimmed) {
		error.value = 'Give the passkey a name first';
		return;
	}
	creating.value = true;
	error.value = null;
	try {
		await authStore.registerPasskey(trimmed);
		// Success flips hasPasskey to true, which hides the modal
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Passkey creation failed';
	} finally {
		creating.value = false;
	}
}

function notNow() {
	authStore.dismissPasskeyNag();
}
</script>

<template>
	<div
		v-if="visible"
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
		data-testid="passkey-nag"
		role="dialog"
		aria-modal="true"
		aria-label="Create a passkey"
	>
		<div class="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
			<div class="flex items-start justify-between">
				<h2 class="text-lg font-semibold text-gray-900 dark:text-white">Secure your account</h2>
			</div>
			<p class="text-sm text-gray-600 dark:text-gray-400">
				A passkey lets you sign in with a fingerprint, face, or security key — no password
				needed. It stays on your device and is phishing-resistant. You'll be asked again on
				your next visit if you skip this now.
			</p>

			<form class="space-y-3" @submit.prevent="createPasskey">
				<div v-if="error" class="text-sm text-error-700 dark:text-error-400">{{ error }}</div>

				<div>
					<label for="passkey-name" class="label">Name this passkey</label>
					<input
						id="passkey-name"
						v-model="name"
						type="text"
						class="input"
						placeholder="e.g. YubiKey 5C, iPhone"
						data-testid="passkey-name-input"
					/>
				</div>

				<div class="flex justify-end gap-3 pt-2">
					<button
						type="button"
						class="btn btn-secondary"
						data-testid="passkey-nag-dismiss"
						:disabled="creating"
						@click="notNow"
					>
						Not now
					</button>
					<button
						type="submit"
						class="btn btn-primary"
						data-testid="passkey-nag-create"
						:disabled="creating"
					>
						{{ creating ? 'Creating…' : 'Create passkey' }}
					</button>
				</div>
			</form>
		</div>
	</div>
</template>
