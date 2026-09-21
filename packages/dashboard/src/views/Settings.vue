<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { type PasskeyCredential, useAuthStore } from '../stores/auth';

const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

const tab = computed(() => (route.query.tab === 'security' ? 'security' : 'general'));

function setTab(next: 'general' | 'security') {
	router.replace({ query: { ...route.query, tab: next } });
}

// --- Change password ---
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const changingPassword = ref(false);
const passwordError = ref<string | null>(null);

async function changePassword() {
	passwordError.value = null;
	if (!currentPassword.value || !newPassword.value) {
		passwordError.value = 'Fill in all fields';
		return;
	}
	if (newPassword.value !== confirmPassword.value) {
		passwordError.value = 'New passwords do not match';
		return;
	}
	if (newPassword.value.length < 8) {
		passwordError.value = 'New password must be at least 8 characters';
		return;
	}
	changingPassword.value = true;
	try {
		// On success the server revokes every session, so this logs out
		await authStore.changePassword(currentPassword.value, newPassword.value);
		router.push('/login');
	} catch (err) {
		passwordError.value = err instanceof Error ? err.message : 'Failed to change password';
	} finally {
		changingPassword.value = false;
	}
}

// --- Passkeys ---
const passkeys = ref<PasskeyCredential[]>([]);
const passkeysLoading = ref(true);
const passkeyError = ref<string | null>(null);
const newPasskeyName = ref('');
const addingPasskey = ref(false);
const deletingPasskeyId = ref<string | null>(null);

const isLastPasskey = computed(() => passkeys.value.length === 1);

async function loadPasskeys() {
	passkeysLoading.value = true;
	passkeyError.value = null;
	try {
		passkeys.value = await authStore.listPasskeys();
	} catch (err) {
		passkeyError.value = err instanceof Error ? err.message : 'Failed to load passkeys';
	} finally {
		passkeysLoading.value = false;
	}
}

async function addPasskey() {
	const trimmed = newPasskeyName.value.trim();
	if (!trimmed) {
		passkeyError.value = 'Give the passkey a name first';
		return;
	}
	addingPasskey.value = true;
	passkeyError.value = null;
	try {
		await authStore.registerPasskey(trimmed);
		newPasskeyName.value = '';
		await loadPasskeys();
	} catch (err) {
		passkeyError.value = err instanceof Error ? err.message : 'Failed to add passkey';
	} finally {
		addingPasskey.value = false;
	}
}

async function removePasskey(credential: PasskeyCredential) {
	const warning = isLastPasskey.value
		? `Delete "${credential.name}"? This is your last passkey — you'll sign in with your password until you add another.`
		: `Delete the passkey "${credential.name}"? This cannot be undone.`;
	if (!confirm(warning)) return;

	deletingPasskeyId.value = credential.id;
	passkeyError.value = null;
	try {
		await authStore.deletePasskey(credential.id);
		await loadPasskeys();
	} catch (err) {
		passkeyError.value = err instanceof Error ? err.message : 'Failed to delete passkey';
	} finally {
		deletingPasskeyId.value = null;
	}
}

function formatDate(value: string | null): string {
	if (!value) return 'Never';
	return new Date(value).toLocaleString();
}

// Load passkeys whenever the Security tab becomes active (covers direct
// URL entry, in-app navigation, and query-only navigation that reuses the
// same component instance)
watch(
	tab,
	(current) => {
		if (current === 'security') {
			loadPasskeys();
		}
	},
	{ immediate: true },
);
</script>

<template>
	<div class="max-w-3xl mx-auto space-y-6">
		<h1 class="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>

		<div class="flex gap-2 border-b border-gray-200 dark:border-gray-700">
			<button
				class="px-4 py-2 text-sm font-medium border-b-2"
				:class="
					tab === 'general'
						? 'border-primary-500 text-primary-600 dark:text-primary-400'
						: 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
				"
				data-testid="settings-tab-general"
				@click="setTab('general')"
			>
				General
			</button>
			<button
				class="px-4 py-2 text-sm font-medium border-b-2"
				:class="
					tab === 'security'
						? 'border-primary-500 text-primary-600 dark:text-primary-400'
						: 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
				"
				data-testid="settings-tab-security"
				@click="setTab('security')"
			>
				Security
			</button>
		</div>

		<!-- General -->
		<div v-if="tab === 'general'" class="card space-y-4" data-testid="settings-general">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-white">Profile</h2>
			<dl class="space-y-3 text-sm">
				<div class="flex justify-between">
					<dt class="text-gray-500 dark:text-gray-400">Display name</dt>
					<dd class="font-medium text-gray-900 dark:text-white">{{ authStore.user?.name }}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-gray-500 dark:text-gray-400">Email</dt>
					<dd class="font-medium text-gray-900 dark:text-white">{{ authStore.user?.email }}</dd>
				</div>
				<div class="flex justify-between">
					<dt class="text-gray-500 dark:text-gray-400">Role</dt>
					<dd class="font-medium text-gray-900 dark:text-white">{{ authStore.user?.role }}</dd>
				</div>
			</dl>
			<p class="text-xs text-gray-400">
				Profile details are read-only for now; passkeys and passwords live under Security.
			</p>
		</div>

		<!-- Security -->
		<div v-else class="space-y-6">
			<!-- Change password -->
			<div class="card space-y-4" data-testid="settings-change-password">
				<h2 class="text-lg font-semibold text-gray-900 dark:text-white">Change password</h2>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					Changing your password signs you out of every device.
				</p>
				<form class="space-y-4" @submit.prevent="changePassword">
					<div v-if="passwordError" class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm">
						{{ passwordError }}
					</div>
					<div>
						<label for="current-password" class="label">Current password</label>
						<input id="current-password" v-model="currentPassword" type="password" autocomplete="current-password" class="input" required />
					</div>
					<div>
						<label for="new-password" class="label">New password</label>
						<input id="new-password" v-model="newPassword" type="password" autocomplete="new-password" class="input" required />
					</div>
					<div>
						<label for="confirm-password" class="label">Confirm new password</label>
						<input id="confirm-password" v-model="confirmPassword" type="password" autocomplete="new-password" class="input" required />
					</div>
					<button type="submit" class="btn btn-primary" :disabled="changingPassword" data-testid="change-password-submit">
						{{ changingPassword ? 'Changing…' : 'Change password' }}
					</button>
				</form>
			</div>

			<!-- Passkeys -->
			<div class="card space-y-4" data-testid="settings-passkeys">
				<h2 class="text-lg font-semibold text-gray-900 dark:text-white">Passkeys</h2>
				<p class="text-sm text-gray-600 dark:text-gray-400">
					Sign in with a fingerprint, face, or security key — no password needed.
				</p>

				<div v-if="passkeyError" class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm">
					{{ passkeyError }}
				</div>

				<div v-if="passkeysLoading" class="text-sm text-gray-500">Loading…</div>

				<ul v-else-if="passkeys.length > 0" class="divide-y divide-gray-200 dark:divide-gray-700">
					<li v-for="credential in passkeys" :key="credential.id" class="py-3 flex items-center justify-between gap-4">
						<div class="min-w-0">
							<p class="text-sm font-medium text-gray-900 dark:text-white truncate">{{ credential.name }}</p>
							<p class="text-xs text-gray-500 dark:text-gray-400">
								Created {{ formatDate(credential.createdAt) }} · Last used {{ formatDate(credential.lastUsedAt) }}
							</p>
						</div>
						<button
							class="btn btn-danger text-sm"
							:disabled="deletingPasskeyId === credential.id"
							:class="isLastPasskey ? 'font-semibold' : ''"
							:title="isLastPasskey ? 'This is your last passkey — password sign-in will still work' : undefined"
							@click="removePasskey(credential)"
						>
							{{ deletingPasskeyId === credential.id ? 'Deleting…' : 'Delete' }}
						</button>
					</li>
				</ul>
				<p v-else class="text-sm text-gray-500 dark:text-gray-400">No passkeys yet.</p>

				<form class="flex items-end gap-3" @submit.prevent="addPasskey">
					<div class="flex-1">
						<label for="new-passkey-name" class="label">Add a passkey</label>
						<input
							id="new-passkey-name"
							v-model="newPasskeyName"
							type="text"
							class="input"
							placeholder="e.g. YubiKey 5C, iPhone"
							data-testid="new-passkey-name"
						/>
					</div>
					<button type="submit" class="btn btn-primary" :disabled="addingPasskey" data-testid="add-passkey-button">
						{{ addingPasskey ? 'Waiting…' : 'Add passkey' }}
					</button>
				</form>
			</div>
		</div>
	</div>
</template>
