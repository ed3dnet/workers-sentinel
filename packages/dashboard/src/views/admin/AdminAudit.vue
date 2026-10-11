<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from '../../api/client';

interface AuditEntry {
	id: string;
	actorEmail: string;
	actorName: string;
	action: string;
	targetType: string;
	targetId: string | null;
	targetLabel: string | null;
	details: Record<string, unknown> | null;
	createdAt: string;
}

const entries = ref<AuditEntry[]>([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const nextCursor = ref<string | null>(null);
const hasMore = ref(false);

async function load(cursor?: string) {
	try {
		const response = await api.get<{
			entries: AuditEntry[];
			nextCursor?: string;
			hasMore: boolean;
		}>(`/api/admin/audit?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
		if (cursor) {
			entries.value.push(...response.entries);
		} else {
			entries.value = response.entries;
		}
		nextCursor.value = response.nextCursor ?? null;
		hasMore.value = response.hasMore;
	} catch (err) {
		error.value = err instanceof Error ? err.message : 'Failed to load audit log';
	} finally {
		loading.value = false;
		loadingMore.value = false;
	}
}

onMounted(() => load());

async function loadMore() {
	if (!nextCursor.value) return;
	loadingMore.value = true;
	await load(nextCursor.value);
}

function formatTime(value: string): string {
	return new Date(value).toLocaleString('en-US', {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
}

function formatDetails(details: Record<string, unknown> | null): string {
	if (!details) return '';
	return JSON.stringify(details);
}
</script>

<template>
	<div>
		<h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-2">Audit log</h1>
		<p class="text-sm text-gray-500 mb-6">
			Every administrative action, newest first.
		</p>

		<div v-if="loading" class="text-center py-12">
			<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
			<p class="mt-4 text-gray-500">Loading audit log...</p>
		</div>

		<div
			v-else-if="error"
			class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg"
		>
			{{ error }}
		</div>

		<div v-else class="card overflow-x-auto">
			<table class="w-full text-sm" data-testid="admin-audit-table">
				<thead>
					<tr class="text-left text-xs text-gray-500 uppercase border-b border-gray-200 dark:border-gray-700">
						<th class="px-4 py-3">Time</th>
						<th class="px-4 py-3">Actor</th>
						<th class="px-4 py-3">Action</th>
						<th class="px-4 py-3">Target</th>
						<th class="px-4 py-3">Details</th>
					</tr>
				</thead>
				<tbody>
					<tr
						v-for="entry in entries"
						:key="entry.id"
						class="border-b border-gray-100 dark:border-gray-800"
					>
						<td class="px-4 py-3 text-gray-500 whitespace-nowrap">
							{{ formatTime(entry.createdAt) }}
						</td>
						<td class="px-4 py-3">
							<div class="font-medium text-gray-900 dark:text-white">
								{{ entry.actorName }}
							</div>
							<div class="text-xs text-gray-500">{{ entry.actorEmail }}</div>
						</td>
						<td class="px-4 py-3">
							<code class="text-xs bg-gray-100 dark:bg-gray-900 rounded px-1.5 py-0.5">
								{{ entry.action }}
							</code>
						</td>
						<td class="px-4 py-3">
							<span class="text-xs text-gray-500">{{ entry.targetType }}</span>
							<div
								v-if="entry.targetLabel"
								class="font-medium text-gray-900 dark:text-white text-xs"
							>
								{{ entry.targetLabel }}
							</div>
						</td>
						<td class="px-4 py-3 text-xs text-gray-500">
							{{ formatDetails(entry.details) }}
						</td>
					</tr>
					<tr v-if="entries.length === 0">
						<td colspan="5" class="px-4 py-8 text-center text-gray-500">
							No admin actions recorded yet.
						</td>
					</tr>
				</tbody>
			</table>

			<div v-if="hasMore" class="p-4 text-center border-t border-gray-100 dark:border-gray-800">
				<button
					class="btn btn-secondary"
					:disabled="loadingMore"
					data-testid="admin-audit-load-more"
					@click="loadMore"
				>
					<span v-if="loadingMore">Loading…</span>
					<span v-else>Load more</span>
				</button>
			</div>
		</div>
	</div>
</template>
