<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api/client';

const registrationOpen = ref<boolean | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);

async function load() {
	loading.value = true;
	error.value = null;
	try {
		const response = await api.get<{ settings: { registrationOpen: boolean } }>(
			'/api/admin/settings',
		);
		registrationOpen.value = response.settings.registrationOpen;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load settings';
	} finally {
		loading.value = false;
	}
}

onMounted(load);

async function toggleRegistration() {
	if (registrationOpen.value === null) return;
	saving.value = true;
	error.value = null;
	try {
		const response = await api.put<{ settings: { registrationOpen: boolean } }>(
			'/api/admin/settings',
			{ registrationOpen: !registrationOpen.value },
		);
		registrationOpen.value = response.settings.registrationOpen;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to update settings';
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<div>
		<h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-6">Settings</h1>

		<div v-if="loading" class="text-center py-12">
			<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
		</div>

		<div
			v-else-if="error"
			class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg"
		>
			{{ error }}
		</div>

		<div v-else class="card p-6 max-w-2xl">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-white mb-2">Registration</h2>
			<p class="text-sm text-gray-500 mb-4">
				When open, anyone can create an account (the first account on a fresh install still
				requires the setup token). When closed, only administrators can add users.
			</p>

			<div class="flex items-center space-x-4">
				<button
					class="btn"
					:class="registrationOpen ? 'btn-danger' : 'btn-primary'"
					:disabled="saving"
					data-testid="admin-settings-registration-toggle"
					@click="toggleRegistration"
				>
					<span v-if="saving">Saving…</span>
					<span v-else>
						{{ registrationOpen ? 'Close registration' : 'Open registration' }}
					</span>
				</button>
				<span
					class="inline-flex items-center px-2 py-1 text-xs font-medium rounded-full"
					:class="
						registrationOpen
							? 'bg-success-100 dark:bg-success-900/30 text-success-700 dark:text-success-300'
							: 'bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-300'
					"
					data-testid="admin-settings-registration-state"
				>
					{{ registrationOpen ? 'Open' : 'Closed' }}
				</span>
			</div>
		</div>
	</div>
</template>
