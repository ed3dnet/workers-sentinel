<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api/client';

interface AdminUser {
	id: string;
	email: string;
	name: string;
}

interface ProjectOwner {
	userId: string;
	email: string;
	name: string;
}

interface AdminProject {
	id: string;
	name: string;
	slug: string;
	platform: string;
	publicKey: string;
	createdAt: string;
	owner: ProjectOwner | null;
	memberCount: number;
}

interface ProjectMember {
	userId: string;
	email: string;
	name: string;
	role: 'owner' | 'admin' | 'member';
}

const projects = ref<AdminProject[]>([]);
const users = ref<AdminUser[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

// Create modal
const showCreate = ref(false);
const createForm = ref({ name: '', platform: 'javascript', ownerId: '' });
const creating = ref(false);
const createError = ref<string | null>(null);
const createdDsn = ref<string | null>(null);

// Rename modal
const renaming = ref<AdminProject | null>(null);
const renameName = ref('');
const renamingBusy = ref(false);
const renameError = ref<string | null>(null);

// Reassign owner modal
const reassigning = ref<AdminProject | null>(null);
const reassignOwnerId = ref('');
const reassignBusy = ref(false);
const reassignError = ref<string | null>(null);

// Members drawer
const membersProject = ref<AdminProject | null>(null);
const members = ref<ProjectMember[]>([]);
const membersLoading = ref(false);
const membersError = ref<string | null>(null);
const newMemberEmail = ref('');
const newMemberRole = ref<'admin' | 'member'>('member');
const addingMember = ref(false);

// Delete confirm (type the project name)
const deleting = ref<AdminProject | null>(null);
const deleteConfirmName = ref('');
const deletingBusy = ref(false);
const deleteError = ref<string | null>(null);

async function load() {
	loading.value = true;
	error.value = null;
	try {
		const [projectsResponse, usersResponse] = await Promise.all([
			api.get<{ projects: AdminProject[] }>('/api/admin/projects'),
			api.get<{ users: AdminUser[] }>('/api/admin/users'),
		]);
		projects.value = projectsResponse.projects;
		users.value = usersResponse.users;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load projects';
	} finally {
		loading.value = false;
	}
}

onMounted(load);

function openCreate() {
	createForm.value = { name: '', platform: 'javascript', ownerId: '' };
	createError.value = null;
	createdDsn.value = null;
	showCreate.value = true;
}

async function createProject() {
	createError.value = null;
	if (!createForm.value.ownerId) {
		createError.value = 'Choose an owner';
		return;
	}
	creating.value = true;
	try {
		const response = await api.post<{ dsn: string }>('/api/admin/projects', {
			name: createForm.value.name,
			platform: createForm.value.platform,
			ownerId: createForm.value.ownerId,
		});
		createdDsn.value = response.dsn;
		await load();
	} catch (err) {
		createError.value = err instanceof Error ? err.message : 'Failed to create project';
	} finally {
		creating.value = false;
	}
}

function openRename(project: AdminProject) {
	renaming.value = project;
	renameName.value = project.name;
	renameError.value = null;
}

async function renameProject() {
	if (!renaming.value) return;
	renamingBusy.value = true;
	renameError.value = null;
	try {
		await api.patch(`/api/admin/projects/${renaming.value.id}`, {
			name: renameName.value,
		});
		renaming.value = null;
		await load();
	} catch (err) {
		renameError.value = err instanceof Error ? err.message : 'Failed to rename project';
	} finally {
		renamingBusy.value = false;
	}
}

function openReassign(project: AdminProject) {
	reassigning.value = project;
	reassignOwnerId.value = project.owner?.userId ?? '';
	reassignError.value = null;
}

async function reassignOwner() {
	if (!reassigning.value) return;
	reassignBusy.value = true;
	reassignError.value = null;
	try {
		await api.post(`/api/admin/projects/${reassigning.value.id}/owner`, {
			userId: reassignOwnerId.value,
		});
		reassigning.value = null;
		await load();
	} catch (err) {
		reassignError.value = err instanceof Error ? err.message : 'Failed to reassign owner';
	} finally {
		reassignBusy.value = false;
	}
}

async function openMembers(project: AdminProject) {
	membersProject.value = project;
	members.value = [];
	membersError.value = null;
	newMemberEmail.value = '';
	newMemberRole.value = 'member';
	await loadMembers();
}

async function loadMembers() {
	if (!membersProject.value) return;
	membersLoading.value = true;
	membersError.value = null;
	try {
		const response = await api.get<{ members: ProjectMember[] }>(
			`/api/admin/projects/${membersProject.value.id}/members`,
		);
		members.value = response.members;
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to load members';
	} finally {
		membersLoading.value = false;
	}
}

async function addMember() {
	if (!membersProject.value || !newMemberEmail.value) return;
	addingMember.value = true;
	membersError.value = null;
	try {
		await api.post(`/api/admin/projects/${membersProject.value.id}/members`, {
			email: newMemberEmail.value,
			role: newMemberRole.value,
		});
		newMemberEmail.value = '';
		newMemberRole.value = 'member';
		await loadMembers();
		await load();
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to add member';
	} finally {
		addingMember.value = false;
	}
}

async function changeMemberRole(member: ProjectMember, role: string) {
	if (!membersProject.value) return;
	membersError.value = null;
	try {
		await api.patch(`/api/admin/projects/${membersProject.value.id}/members/${member.userId}`, {
			role,
		});
		await loadMembers();
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to change role';
	}
}

async function removeMember(member: ProjectMember) {
	if (!membersProject.value) return;
	membersError.value = null;
	try {
		await api.delete(`/api/admin/projects/${membersProject.value.id}/members/${member.userId}`);
		await loadMembers();
		await load();
	} catch (err) {
		membersError.value = err instanceof Error ? err.message : 'Failed to remove member';
	}
}

function openDelete(project: AdminProject) {
	deleting.value = project;
	deleteConfirmName.value = '';
	deleteError.value = null;
}

async function deleteProject() {
	if (!deleting.value) return;
	deletingBusy.value = true;
	deleteError.value = null;
	try {
		await api.delete(`/api/admin/projects/${deleting.value.id}`);
		deleting.value = null;
		await load();
	} catch (err) {
		deleteError.value = err instanceof Error ? err.message : 'Failed to delete project';
	} finally {
		deletingBusy.value = false;
	}
}

function formatDate(value: string): string {
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
			<h1 class="text-2xl font-bold text-gray-900 dark:text-white">Projects</h1>
			<button class="btn btn-primary" data-testid="admin-projects-create" @click="openCreate">
				Create project
			</button>
		</div>

		<div v-if="loading" class="text-center py-12">
			<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
			<p class="mt-4 text-gray-500">Loading projects...</p>
		</div>

		<div
			v-else-if="error"
			class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg"
		>
			{{ error }}
		</div>

		<div v-else class="card overflow-x-auto">
			<table class="w-full text-sm" data-testid="admin-projects-table">
				<thead>
					<tr class="text-left text-xs text-gray-500 uppercase border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3">Name</th>
						<th class="px-4 py-3">Slug</th>
						<th class="px-4 py-3">Owner</th>
						<th class="px-4 py-3">Members</th>
						<th class="px-4 py-3">Created</th>
						<th class="px-4 py-3 text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="project in projects"
						:key="project.id"
						class="border-b border-gray-100 dark:border-gray-800"
						:data-testid="`admin-project-row-${project.slug}`"
					>
						<td class="px-4 py-3 font-medium text-gray-900 dark:text-white">
							{{ project.name }}
						</td>
						<td class="px-4 py-3 text-gray-500">{{ project.slug }}</td>
						<td class="px-4 py-3 text-gray-500">
							{{ project.owner ? project.owner.email : '—' }}
						</td>
						<td class="px-4 py-3 text-gray-500">{{ project.memberCount }}</td>
						<td class="px-4 py-3 text-gray-500">{{ formatDate(project.createdAt) }}</td>
						<td class="px-4 py-3 text-right space-x-1 whitespace-nowrap">
							<button
								class="text-primary-600 dark:text-primary-400 hover:underline text-xs"
								:data-testid="`admin-project-rename-${project.slug}`"
								@click="openRename(project)"
							>
								Rename
							</button>
							<button
								class="text-primary-600 dark:text-primary-400 hover:underline text-xs"
								:data-testid="`admin-project-owner-${project.slug}`"
								@click="openReassign(project)"
							>
								Reassign owner
							</button>
							<button
								class="text-primary-600 dark:text-primary-400 hover:underline text-xs"
								:data-testid="`admin-project-members-${project.slug}`"
								@click="openMembers(project)"
							>
								Members
							</button>
							<button
								class="text-error-600 dark:text-error-400 hover:underline text-xs"
								:data-testid="`admin-project-delete-${project.slug}`"
								@click="openDelete(project)"
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
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-4">
					Create project
				</h3>
				<div v-if="createdDsn" class="space-y-3">
					<p class="text-sm text-gray-500">Project created. Its DSN:</p>
					<code
						class="block bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded px-3 py-2 text-xs break-all"
						data-testid="admin-created-dsn"
					>
						{{ createdDsn }}
					</code>
					<div class="flex justify-end">
						<button class="btn btn-primary" @click="showCreate = false">Done</button>
					</div>
				</div>
				<div v-else class="space-y-4">
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
						<input
							v-model="createForm.name"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-project-create-name"
						/>
					</div>
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Platform</label>
						<select
							v-model="createForm.platform"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						>
							<option value="javascript">javascript</option>
							<option value="python">python</option>
							<option value="ruby">ruby</option>
							<option value="go">go</option>
							<option value="node">node</option>
						</select>
					</div>
					<div>
						<label class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Owner</label>
						<select
							v-model="createForm.ownerId"
							class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
							data-testid="admin-project-create-owner"
						>
							<option value="" disabled>Choose an owner…</option>
							<option v-for="user in users" :key="user.id" :value="user.id">
								{{ user.name }} ({{ user.email }})
							</option>
						</select>
					</div>
					<div
						v-if="createError"
						class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
						data-testid="admin-project-create-error"
					>
						{{ createError }}
					</div>
					<div class="flex justify-end space-x-3">
						<button class="btn btn-secondary" @click="showCreate = false">Cancel</button>
						<button
							class="btn btn-primary"
							:disabled="creating || !createForm.name || !createForm.ownerId"
							data-testid="admin-project-create-submit"
							@click="createProject"
						>
							<span v-if="creating">Creating…</span>
							<span v-else>Create</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Rename modal -->
		<div
			v-if="renaming"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="renaming = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">Rename project</h3>
				<p class="text-sm text-gray-500 mb-4">
					The display name changes; the slug <code>{{ renaming.slug }}</code> is permanent.
				</p>
				<div class="space-y-4">
					<input
						v-model="renameName"
						class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						data-testid="admin-project-rename-input"
					/>
					<div
						v-if="renameError"
						class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
					>
						{{ renameError }}
					</div>
					<div class="flex justify-end space-x-3">
						<button class="btn btn-secondary" @click="renaming = null">Cancel</button>
						<button
							class="btn btn-primary"
							:disabled="renamingBusy || !renameName"
							data-testid="admin-project-rename-submit"
							@click="renameProject"
						>
							<span v-if="renamingBusy">Saving…</span>
							<span v-else>Save</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Reassign owner modal -->
		<div
			v-if="reassigning"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="reassigning = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">
					Reassign owner
				</h3>
				<p class="text-sm text-gray-500 mb-4">
					The previous owner stays on as a project admin.
				</p>
				<div class="space-y-4">
					<select
						v-model="reassignOwnerId"
						class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						data-testid="admin-project-owner-select"
					>
						<option v-for="user in users" :key="user.id" :value="user.id">
							{{ user.name }} ({{ user.email }})
						</option>
					</select>
					<div
						v-if="reassignError"
						class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
					>
						{{ reassignError }}
					</div>
					<div class="flex justify-end space-x-3">
						<button class="btn btn-secondary" @click="reassigning = null">Cancel</button>
						<button
							class="btn btn-primary"
							:disabled="reassignBusy || !reassignOwnerId"
							data-testid="admin-project-owner-submit"
							@click="reassignOwner"
						>
							<span v-if="reassignBusy">Saving…</span>
							<span v-else>Reassign</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Members drawer -->
		<div
			v-if="membersProject"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="membersProject = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-lg w-full mx-4 max-h-[85vh] overflow-y-auto">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-1">
					Members — {{ membersProject.name }}
				</h3>
				<p class="text-sm text-gray-500 mb-4">
					The owner is fixed; reassign ownership from the project row.
				</p>

				<div
					v-if="membersError"
					class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm mb-4"
				>
					{{ membersError }}
				</div>

				<div v-if="membersLoading" class="text-center py-4">
					<div class="animate-spin rounded-full h-6 w-6 border-b-2 border-primary-600 mx-auto"></div>
				</div>

				<div v-else class="space-y-2 mb-6">
					<div
						v-for="member in members"
						:key="member.userId"
						class="flex items-center justify-between py-2 px-3 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
					>
						<div class="min-w-0">
							<div class="text-sm font-medium text-gray-900 dark:text-white truncate">
								{{ member.name }}
							</div>
							<div class="text-xs text-gray-500 truncate">{{ member.email }}</div>
						</div>
						<div class="flex items-center space-x-2 flex-shrink-0">
							<template v-if="member.role === 'owner'">
								<span
									class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300"
								>
									Owner
								</span>
							</template>
							<template v-else>
								<select
									:value="member.role"
									class="text-xs bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded px-2 py-1 text-gray-900 dark:text-gray-100"
									@change="changeMemberRole(member, ($event.target as HTMLSelectElement).value)"
								>
									<option value="admin">Admin</option>
									<option value="member">Member</option>
								</select>
								<button
									class="text-gray-400 hover:text-error-600 dark:hover:text-error-400 p-1"
									title="Remove member"
									@click="removeMember(member)"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</template>
						</div>
					</div>
				</div>

				<div class="border-t border-gray-200 dark:border-gray-600 pt-4">
					<h4 class="text-sm font-medium text-gray-900 dark:text-white mb-3">Add member</h4>
					<div class="flex items-end space-x-2">
						<div class="flex-1">
							<input
								v-model="newMemberEmail"
								type="email"
								placeholder="user@example.com"
								class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
								data-testid="admin-project-member-email"
							/>
						</div>
						<select
							v-model="newMemberRole"
							class="px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
						</select>
						<button
							class="btn btn-primary"
							:disabled="addingMember || !newMemberEmail"
							data-testid="admin-project-member-add"
							@click="addMember"
						>
							<span v-if="addingMember">Adding…</span>
							<span v-else>Add</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Delete confirm: type the project name -->
		<div
			v-if="deleting"
			class="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
			@click.self="deleting = null"
		>
			<div class="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
				<h3 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">
					Delete project
				</h3>
				<p class="text-sm text-gray-500 mb-4">
					This permanently removes <strong>{{ deleting.name }}</strong> and purges all of
					its events, attachments, and statistics. Type the project name to confirm:
				</p>
				<div class="space-y-4">
					<input
						v-model="deleteConfirmName"
						class="w-full px-3 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-900 dark:text-gray-100"
						data-testid="admin-project-delete-confirm"
					/>
					<div
						v-if="deleteError"
						class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg text-sm"
					>
						{{ deleteError }}
					</div>
					<div class="flex justify-end space-x-3">
						<button class="btn btn-secondary" @click="deleting = null">Cancel</button>
						<button
							class="btn btn-danger"
							:disabled="deletingBusy || deleteConfirmName !== deleting.name"
							data-testid="admin-project-delete-submit"
							@click="deleteProject"
						>
							<span v-if="deletingBusy">Deleting…</span>
							<span v-else>Delete project</span>
						</button>
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
