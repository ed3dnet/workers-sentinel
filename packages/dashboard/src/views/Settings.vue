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

// --- Profile (General tab) ---
const profileName = ref(authStore.user?.name ?? '');
const profileEmail = ref(authStore.user?.email ?? '');
const savingProfile = ref(false);
const profileError = ref<string | null>(null);
const profileSuccess = ref(false);

const profileDirty = computed(
	() =>
		profileName.value !== (authStore.user?.name ?? '') ||
		profileEmail.value !== (authStore.user?.email ?? ''),
);

async function saveProfile() {
	if (!profileDirty.value || savingProfile.value) return;
	profileError.value = null;
	profileSuccess.value = false;
	savingProfile.value = true;
	try {
		await authStore.updateProfile(profileName.value, profileEmail.value);
		// Re-sync from the store so the server's normalization (trim,
		// lowercase) is reflected in the inputs
		profileName.value = authStore.user?.name ?? profileName.value;
		profileEmail.value = authStore.user?.email ?? profileEmail.value;
		profileSuccess.value = true;
	} catch (err) {
		profileError.value = err instanceof Error ? err.message : 'Failed to update profile';
	} finally {
		savingProfile.value = false;
	}
}

// A fresh edit invalidates the previous success note
watch(profileDirty, (dirty) => {
	if (dirty) profileSuccess.value = false;
});

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
			<form class="space-y-4" @submit.prevent="saveProfile">
				<div
					v-if="profileError"
					class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
					data-testid="profile-error"
				>
					{{ profileError }}
				</div>
				<div
					v-if="profileSuccess"
					class="bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 px-4 py-3 rounded-lg text-sm"
					data-testid="profile-success"
				>
					Profile updated
				</div>
				<div>
					<label for="profile-name" class="label">Display name</label>
					<input
						id="profile-name"
						v-model="profileName"
						type="text"
						class="input"
						maxlength="100"
						required
						data-testid="profile-name-input"
					/>
				</div>
				<div>
					<label for="profile-email" class="label">Email</label>
					<!-- type="text" on purpose: the server deliberately applies no
						email-format validation, and a type="email" input would impose
						browser constraint validation the endpoint doesn't have -->
					<input
						id="profile-email"
						v-model="profileEmail"
						type="text"
						autocomplete="username"
						inputmode="email"
						class="input"
						maxlength="254"
						required
						data-testid="profile-email-input"
					/>
				</div>
				<div class="flex justify-between text-sm">
					<span class="text-gray-500 dark:text-gray-400">Role</span>
					<span class="font-medium text-gray-900 dark:text-white">{{
						authStore.user?.role
					}}</span>
				</div>
				<button
					type="submit"
					class="btn btn-primary"
					:disabled="savingProfile || !profileDirty"
					data-testid="profile-save"
				>
					{{ savingProfile ? 'Saving…' : 'Save changes' }}
				</button>
			</form>
			<p class="text-xs text-gray-400">
				Your email is your sign-in identifier — you'll use the new one next time you sign in.
				Passkeys and passwords live under Security.
			</p>
		</div>

		<!-- Security -->
		<div v-else class="space-y-6">
			<!-- Admin tools unlock note (admins on password sessions) -->
			<div
				v-if="authStore.isAdmin && !authStore.canUseAdmin"
				class="bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300 px-4 py-3 rounded-lg text-sm"
				data-testid="admin-passkey-note"
			>
				Sign out and back in with your passkey to unlock admin tools. Admin actions require
				a passkey-signed-in session.
			</div>

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
