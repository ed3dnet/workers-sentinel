<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError, api } from '../../api/client';

interface AdminUser {
	id: string;
	email: string;
	name: string;
	role: 'admin' | 'member';
	disabled: boolean;
	mustChangePassword: boolean;
	lastLoginAt: string | null;
	passkeyCount: number;
	membershipCount: number;
	createdAt: string;
}

interface OwnedProject {
	id: string;
	name: string;
	slug: string;
}

const users = ref<AdminUser[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Create modal
const showCreate = ref(false);
const createForm = ref({ name: '', email: '', password: '', isAdmin: false });
const creating = ref(false);
const createError = ref<string | null>(null);

// Edit modal
const editing = ref<AdminUser | null>(null);
const editForm = ref({
	name: '',
	email: '',
	role: 'member' as 'admin' | 'member',
	disabled: false,
});
const savingEdit = ref(false);
const editError = ref<string | null>(null);

// Reset password modal
const resetting = ref<AdminUser | null>(null);
const newPassword = ref('');
const resettingBusy = ref(false);
const resetError = ref<string | null>(null);

// Delete confirm
const deleting = ref<AdminUser | null>(null);
const deleteBusy = ref(false);
const deleteError = ref<string | null>(null);
const deleteBlockedProjects = ref<OwnedProject[] | null>(null);

// Remove passkeys confirm
const clearingPasskeys = ref<AdminUser | null>(null);
const clearBusy = ref(false);

async function loadUsers() {
	loading.value = true;
	error.value = null;
	try {
		const response = await api.get<{ users: AdminUser[] }>('/api/admin/users');
		users.value = response.users;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load users';
	} finally {
		loading.value = false;
	}
}

onMounted(loadUsers);

function openCreate() {
	createForm.value = { name: '', email: '', password: '', isAdmin: false };
	createError.value = null;
	showCreate.value = true;
}

async function createUser() {
	createError.value = null;
	if (createForm.value.password.length < 8) {
		createError.value = 'Temporary password must be at least 8 characters';
		return;
	}
	creating.value = true;
	try {
		await api.post('/api/admin/users', {
			name: createForm.value.name,
			email: createForm.value.email,
			password: createForm.value.password,
			role: createForm.value.isAdmin ? 'admin' : 'member',
		});
		showCreate.value = false;
		await loadUsers();
	} catch (err) {
		createError.value = err instanceof Error ? err.message : 'Failed to create user';
	} finally {
		creating.value = false;
	}
}

function openEdit(user: AdminUser) {
	editing.value = user;
	editForm.value = {
		name: user.name,
		email: user.email,
		role: user.role,
		disabled: user.disabled,
	};
	editError.value = null;
}

async function saveEdit() {
	if (!editing.value) return;
	savingEdit.value = true;
	editError.value = null;
	try {
		const response = await api.patch<{ user: AdminUser }>(`/api/admin/users/${editing.value.id}`, {
			name: editForm.value.name,
			email: editForm.value.email,
			role: editForm.value.role,
			disabled: editForm.value.disabled,
		});
		editing.value = null;
		await loadUsers();
		// Keep a handle on the updated row (not strictly needed; loadUsers refreshes)
		void response;
	} catch (err) {
		editError.value = err instanceof Error ? err.message : 'Failed to update user';
	} finally {
		savingEdit.value = false;
	}
}

function openReset(user: AdminUser) {
	resetting.value = user;
	newPassword.value = '';
	resetError.value = null;
}

async function resetPassword() {
	if (!resetting.value) return;
	resetError.value = null;
	if (newPassword.value.length < 8) {
		resetError.value = 'Temporary password must be at least 8 characters';
		return;
	}
	resettingBusy.value = true;
	try {
		await api.post(`/api/admin/users/${resetting.value.id}/reset-password`, {
			newPassword: newPassword.value,
		});
		resetting.value = null;
		await loadUsers();
	} catch (err) {
		resetError.value = err instanceof Error ? err.message : 'Failed to reset password';
	} finally {
		resettingBusy.value = false;
	}
}

async function removePasskeys() {
	if (!clearingPasskeys.value) return;
	clearBusy.value = true;
	try {
		await api.delete(`/api/admin/users/${clearingPasskeys.value.id}/passkeys`);
		clearingPasskeys.value = null;
		await loadUsers();
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to remove passkeys';
	} finally {
		clearBusy.value = false;
	}
}

function openDelete(user: AdminUser) {
	deleting.value = user;
	deleteError.value = null;
	deleteBlockedProjects.value = null;
}

async function deleteUser() {
	if (!deleting.value) return;
	deleteBusy.value = true;
	deleteError.value = null;
	deleteBlockedProjects.value = null;
	try {
		await api.delete(`/api/admin/users/${deleting.value.id}`);
		deleting.value = null;
		await loadUsers();
	} catch (err) {
		if (err instanceof ApiError && err.code === 'owns_projects') {
			const projects = err.body?.projects;
			deleteBlockedProjects.value = Array.isArray(projects) ? (projects as OwnedProject[]) : [];
		}
		deleteError.value = err instanceof Error ? err.message : 'Failed to delete user';
	} finally {
		deleteBusy.value = false;
	}
}

function formatDate(value: string | null): string {
	if (!value) return '—';
	return new Date(value).toLocaleDateString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
}
</script>

<template>
	<div>
		<div class="flex items-center justify-between mb-6">
			<h1 class="text-2xl font-bold text-gray-900 dark:text-white">Users</h1>
			<button class="btn btn-primary" data-testid="admin-users-create" @click="openCreate">
				Create user
			</button>
		</div>

		<div v-if="loading" class="text-center py-12">
			<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
			<p class="mt-4 text-gray-500">Loading users...</p>
		</div>

		<div
			v-else-if="error"
			class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg"
		>
			{{ error }}
		</div>

		<div v-else class="card overflow-x-auto">
			<table class="w-full text-sm" data-testid="admin-users-table">
				<thead>
					<tr class="text-left text-xs text-gray-500 uppercase border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3">Name</th>
						<th class="px-4 py-3">Email</th>
						<th class="px-4 py-3">Role</th>
						<th class="px-4 py-3">Status</th>
						<th class="px-4 py-3">Passkeys</th>
						<th class="px-4 py-3">Last sign-in</th>
						<th class="px-4 py-3">Created</th>
						<th class="px-4 py-3 text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="user in users"
						:key="user.id"
						class="border-b border-gray-100 dark:border-gray-800"
						:data-testid="`admin-user-row-${user.email}`"
					>
						<td class="px-4 py-3 font-medium text-gray-900 dark:text-white">
							{{ user.name }}
						</td>
						<td class="px-4 py-3 text-gray-500">{{ user.email }}</td>
						<td class="px-4 py-3">
							<span
								class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full"
								:class="
									user.role === 'admin'
										? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300'
										: 'bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-300'
								"
							>
								{{ user.role === 'admin' ? 'Admin' : 'Member' }}
							</span>
						</td>
						<td class="px-4 py-3">
							<span
								v-if="user.disabled"
								class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-error-100 dark:bg-error-900/30 text-error-700 dark:text-error-300"
							>
								Disabled
							</span>
							<span
								v-else-if="user.mustChangePassword"
								class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-warning-100 dark:bg-warning-900/30 text-warning-700 dark:text-warning-300"
							>
								Password change due
							</span>
							<span v-else class="text-xs text-gray-500">Active</span>
						</td>
						<td class="px-4 py-3 text-gray-500">{{ user.passkeyCount }}</td>
						<td class="px-4 py-3 text-gray-500">{{ formatDate(user.lastLoginAt) }}</td>
						<td class="px-4 py-3 text-gray-500">{{ formatDate(user.createdAt) }}</td>
						<td class="px-4 py-3 text-right space-x-1 whitespace-nowrap">
							<button
								class="text-primary-600 dark:text-primary-400 hover:underline text-xs"
								:data-testid="`admin-user-edit-${user.email}`"
								@click="openEdit(user)"
							>
								Edit
							</button>
							<button
								class="text-primary-600 dark:text-primary-400 hover:underline text-xs"
								:data-testid="`admin-user-reset-${user.email}`"
								@click="openReset(user)"
							>
								Reset password
							</button>
							<button
								class="text-primary-600 dark:text-primary-400 hover:underline text-xs"
								:data-testid="`admin-user-passkeys-${user.email}`"
								@click="clearingPasskeys = user"
							>
								Remove passkeys
							</button>
							<button
								class="text-error-600 dark:text-error-400 hover:underline text-xs"
								:data-testid="`admin-user-delete-${user.email}`"
								@click="openDelete(user)"
							>
								Delete
							</button>
						</td>
					</tr>
				</tbody>
			</table>
		</div>

		<!-- Create modal -->
		<div
			v-if="showCreate"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="showCreate = false"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Create user</h3>
				<div class="space-y-4">
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
						<input
							v-model="createForm.name"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-create-name"
						/>
					</div>
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
						<input
							v-model="createForm.email"
							type="email"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-create-email"
						/>
					</div>
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
							Temporary password
						</label>
						<input
							v-model="createForm.password"
							type="text"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-create-password"
						/>
						<p class="text-xs text-gray-500 mt-1">
							The user must change this password at first sign-in.
						</p>
					</div>
					<label class="flex items-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
						<input
							v-model="createForm.isAdmin"
							type="checkbox"
							data-testid="admin-create-is-admin"
						/>
						<span>This is an administrator</span>
					</label>
					<div
						v-if="createError"
						class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
						data-testid="admin-create-error"
					>
						{{ createError }}
					</div>
					<div class="flex justify-end space-x-3">
						<button class="btn btn-secondary" @click="showCreate = false">Cancel</button>
						<button
							class="btn btn-primary"
							:disabled="creating || !createForm.name || !createForm.email || !createForm.password"
							data-testid="admin-create-submit"
							@click="createUser"
						>
							<span v-if="creating">Creating…</span>
							<span v-else>Create</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Edit modal -->
		<div
			v-if="editing"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="editing = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">Edit user</h3>
				<div class="space-y-4">
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
						<input
							v-model="editForm.name"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-edit-name"
						/>
					</div>
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
						<input
							v-model="editForm.email"
							type="email"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-edit-email"
						/>
					</div>
					<div class="flex items-center space-x-4">
						<label class="flex items-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
							<input
								v-model="editForm.role"
								type="radio"
								value="member"
								data-testid="admin-edit-role-member"
							/>
							<span>Member</span>
						</label>
						<label class="flex items-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
							<input
								v-model="editForm.role"
								type="radio"
								value="admin"
								data-testid="admin-edit-role-admin"
							/>
							<span>Admin</span>
						</label>
					</div>
					<label class="flex items-center space-x-2 text-sm text-gray-700 dark:text-gray-300">
						<input
							v-model="editForm.disabled"
							type="checkbox"
							data-testid="admin-edit-disabled"
						/>
						<span>Disabled (blocks sign-in, kills sessions)</span>
					</label>
					<div
						v-if="editError"
						class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
						data-testid="admin-edit-error"
					>
						{{ editError }}
					</div>
					<div class="flex justify-end space-x-3">
						<button class="btn btn-secondary" @click="editing = null">Cancel</button>
						<button
							class="btn btn-primary"
							:disabled="savingEdit"
							data-testid="admin-edit-submit"
							@click="saveEdit"
						>
							<span v-if="savingEdit">Saving…</span>
							<span v-else>Save</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Reset password modal -->
		<div
			v-if="resetting"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="resetting = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">
					Reset password
				</h3>
				<p class="text-sm text-gray-500 mb-4">
					{{ resetting.email }} will be signed out everywhere and must change this
					temporary password at next sign-in.
				</p>
				<div class="space-y-4">
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
							New temporary password
						</label>
						<input
							v-model="newPassword"
							type="text"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-reset-password"
						/>
					</div>
					<div
						v-if="resetError"
						class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
					>
						{{ resetError }}
					</div>
					<div class="flex justify-end space-x-3">
						<button class="btn btn-secondary" @click="resetting = null">Cancel</button>
						<button
							class="btn btn-primary"
							:disabled="resettingBusy || newPassword.length < 8"
							data-testid="admin-reset-submit"
							@click="resetPassword"
						>
							<span v-if="resettingBusy">Resetting…</span>
							<span v-else>Reset password</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Remove passkeys confirm -->
		<div
			v-if="clearingPasskeys"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="clearingPasskeys = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">
					Remove all passkeys?
				</h3>
				<p class="text-sm text-gray-500 mb-6">
					{{ clearingPasskeys.email }} ({{ clearingPasskeys.passkeyCount }} passkeys) will
					fall back to password sign-in.
				</p>
				<div class="flex justify-end space-x-3">
					<button class="btn btn-secondary" @click="clearingPasskeys = null">Cancel</button>
					<button class="btn btn-danger" :disabled="clearBusy" @click="removePasskeys">
						<span v-if="clearBusy">Removing…</span>
						<span v-else>Remove passkeys</span>
					</button>
				</div>
			</div>
		</div>

		<!-- Delete confirm -->
		<div
			v-if="deleting"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="deleting = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">Delete user?</h3>
				<p class="text-sm text-gray-500 mb-4">
					{{ deleting.email }} — all sessions, API tokens, passkeys, and project
					memberships will be removed.
				</p>
				<div
					v-if="deleteBlockedProjects"
					class="bg-warning-50 dark:bg-warning-900/20 text-warning-700 dark:text-warning-300 px-4 py-3 rounded-lg text-sm mb-4"
					data-testid="admin-delete-blocked"
				>
					<p class="font-medium mb-1">
						This user owns projects — reassign or delete these first:
					</p>
					<ul class="list-disc list-inside">
						<li v-for="project in deleteBlockedProjects" :key="project.id">
							{{ project.name }} ({{ project.slug }})
						</li>
					</ul>
				</div>
				<div
					v-else-if="deleteError"
					class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm mb-4"
				>
					{{ deleteError }}
				</div>
				<div class="flex justify-end space-x-3">
					<button class="btn btn-secondary" @click="deleting = null">Cancel</button>
					<button
						class="btn btn-danger"
						:disabled="deleteBusy || !!deleteBlockedProjects"
						data-testid="admin-delete-submit"
						@click="deleteUser"
					>
						<span v-if="deleteBusy">Deleting…</span>
						<span v-else>Delete user</span>
					</button>
				</div>
			</div>
		</div>
	</div>
</template>
