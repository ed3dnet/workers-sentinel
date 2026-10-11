<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';
import FeedbackQuickSetup from '../components/FeedbackQuickSetup.vue';

interface Feedback {
	id: string;
	description: string;
	pageUrl: string | null;
	pageTitle: string | null;
	locator: unknown;
	geometry: unknown;
	receivedAt: string;
	screenshotType: string | null;
	screenshotSize: number | null;
	status: 'unresolved' | 'resolved';
}
interface FeedbackPage {
	feedback: Feedback[];
	nextCursor?: string;
	hasMore: boolean;
}
const route = useRoute();
const slug = computed(() => route.params.slug as string);
const pageSize = ref(25);
const status = ref<'all' | 'unresolved' | 'resolved'>('all');
const searchInput = ref('');
const query = ref('');
const feedback = ref<Feedback[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const hasMore = ref(false);
const nextCursor = ref<string | undefined>();
const projectDsn = ref<string | null>(null);
const sdkExpanded = ref(false);
const pendingStatusKeys = ref(new Set<string>());
let listRequest = 0;
let listContext = 0;
let dsnRequest = 0;
let initialResultProcessed = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function contextIsCurrent(
	context: number,
	currentSlug: string,
	currentStatus: string,
	currentSize: number,
	currentQuery: string,
) {
	return (
		context === listContext &&
		currentSlug === slug.value &&
		currentStatus === status.value &&
		currentSize === pageSize.value &&
		currentQuery === query.value
	);
}
function mutationKey(context: number, id: string) {
	return `${context}:${id}`;
}
function isStatusPending(id: string) {
	return pendingStatusKeys.value.has(mutationKey(listContext, id));
}

async function loadFeedback(append = false) {
	const requestId = ++listRequest;
	const context = listContext;
	const currentSlug = slug.value;
	const currentStatus = status.value;
	const currentSize = pageSize.value;
	const currentQuery = query.value;
	const isCurrent = () =>
		requestId === listRequest &&
		contextIsCurrent(context, currentSlug, currentStatus, currentSize, currentQuery);
	loading.value = true;
	error.value = null;
	try {
		const params = new URLSearchParams({ limit: String(currentSize) });
		if (currentStatus !== 'all') params.set('status', currentStatus);
		if (currentQuery) params.set('query', currentQuery);
		if (append && nextCursor.value) params.set('cursor', nextCursor.value);
		const response = await api.get<FeedbackPage>(
			`/api/projects/${encodeURIComponent(currentSlug)}/feedback?${params}`,
		);
		if (!isCurrent()) return;
		if (!append && !initialResultProcessed && currentStatus === 'all' && currentQuery === '') {
			sdkExpanded.value = response.feedback.length === 0;
			initialResultProcessed = true;
		}
		feedback.value = append ? [...feedback.value, ...response.feedback] : response.feedback;
		hasMore.value = response.hasMore;
		nextCursor.value = response.nextCursor;
	} catch (err) {
		if (isCurrent()) error.value = err instanceof Error ? err.message : 'Failed to load feedback';
	} finally {
		if (isCurrent()) loading.value = false;
	}
}
function resetAndLoad() {
	listContext++;
	listRequest++;
	feedback.value = [];
	nextCursor.value = undefined;
	hasMore.value = false;
	loadFeedback();
}
function updateSearch(value: string) {
	searchInput.value = value.slice(0, 200);
	listContext++;
	listRequest++;
	feedback.value = [];
	nextCursor.value = undefined;
	hasMore.value = false;
	loading.value = true;
	error.value = null;
	if (searchTimer) clearTimeout(searchTimer);
	searchTimer = setTimeout(() => {
		searchTimer = undefined;
		query.value = searchInput.value.trim();
		resetAndLoad();
	}, 250);
}
async function setFeedbackStatus(item: Feedback, nextStatus: 'resolved' | 'unresolved') {
	const context = listContext;
	const currentSlug = slug.value;
	const currentStatus = status.value;
	const currentSize = pageSize.value;
	const currentQuery = query.value;
	const key = mutationKey(context, item.id);
	if (pendingStatusKeys.value.has(key) || !feedback.value.includes(item)) return;
	pendingStatusKeys.value = new Set(pendingStatusKeys.value).add(key);
	const isCurrent = () =>
		contextIsCurrent(context, currentSlug, currentStatus, currentSize, currentQuery) &&
		feedback.value.includes(item);
	try {
		await api.patch(
			`/api/projects/${encodeURIComponent(currentSlug)}/feedback/${encodeURIComponent(item.id)}`,
			{ status: nextStatus },
		);
		if (!isCurrent()) return;
		item.status = nextStatus;
		if (currentStatus !== 'all' && currentStatus !== nextStatus) {
			feedback.value = feedback.value.filter((entry) => entry !== item);
		}
	} catch (err) {
		if (isCurrent()) error.value = err instanceof Error ? err.message : 'Failed to update feedback';
	} finally {
		const pending = new Set(pendingStatusKeys.value);
		pending.delete(key);
		pendingStatusKeys.value = pending;
	}
}
async function loadProject(projectSlug: string) {
	const requestId = ++dsnRequest;
	try {
		const project = await api.get<{ dsn?: string }>(
			`/api/projects/${encodeURIComponent(projectSlug)}`,
		);
		if (requestId !== dsnRequest || projectSlug !== slug.value) return;
		projectDsn.value = typeof project.dsn === 'string' ? project.dsn : null;
	} catch {
		if (requestId === dsnRequest && projectSlug === slug.value) projectDsn.value = null;
	}
}
const sdkScript = computed(() => {
	if (!projectDsn.value) return '';
	let dsnUrl: URL;
	try {
		dsnUrl = new URL(projectDsn.value);
	} catch {
		return '';
	}
	if (!['http:', 'https:'].includes(dsnUrl.protocol) || !dsnUrl.hostname) return '';
	const dsnOrigin = dsnUrl.origin;
	const closingScript = '<' + '/script>';
	return `<script src="${dsnOrigin}/sdk/feedback.js">${closingScript}\n<script>\n  window.WorkersSentinelFeedback.install({ dsn: ${JSON.stringify(projectDsn.value)} });\n${closingScript}`;
});
function formatTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
	if (seconds < 60) return 'just now';
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
	return date.toLocaleDateString();
}
onMounted(() => {
	loadFeedback();
	loadProject(slug.value);
});
watch(
	slug,
	(projectSlug) => {
		initialResultProcessed = false;
		sdkExpanded.value = false;
		projectDsn.value = null;
		loadProject(projectSlug);
		if (searchTimer) {
			clearTimeout(searchTimer);
			searchTimer = undefined;
			query.value = searchInput.value.trim();
		}
		resetAndLoad();
	},
	{ flush: 'sync' },
);
watch([status, pageSize], resetAndLoad);
onBeforeUnmount(() => {
	listContext++;
	listRequest++;
	dsnRequest++;
	if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
	<div>
		<div class="flex items-center space-x-4 mb-4">
			<select v-model="status" class="input w-auto" aria-label="Feedback status">
				<option value="all">All Feedback</option>
				<option value="unresolved">Unresolved</option>
				<option value="resolved">Resolved</option>
			</select>
			<select
				v-model.number="pageSize"
				class="input w-auto"
				title="Feedback per page"
				aria-label="Feedback per page"
			>
				<option :value="25">25 / page</option>
				<option :value="50">50 / page</option>
				<option :value="100">100 / page</option>
			</select>
			<label class="sr-only" for="feedback-search">Search feedback</label>
			<input
				id="feedback-search"
				class="input w-auto"
				type="search"
				maxlength="200"
				placeholder="Search feedback"
				:value="searchInput"
				@input="updateSearch(($event.target as HTMLInputElement).value)"
			/>
		</div>

		<div v-if="loading && feedback.length === 0" role="status" class="text-center py-12">
			<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600 mx-auto"></div>
			<p class="mt-4 text-gray-500">Loading feedback...</p>
		</div>
		<div
			v-else-if="error"
			role="alert"
			class="bg-error-50 dark:bg-error-900/20 text-error-700 dark:text-error-400 px-4 py-3 rounded-lg"
		>
			{{ error }}
			<button class="btn btn-secondary ml-3" :disabled="loading" @click="loadFeedback()">
				Retry
			</button>
		</div>
		<div
			v-else-if="feedback.length === 0 && !query && status === 'all'"
			role="status"
			class="max-w-2xl mx-auto"
		>
			<div class="text-center py-8">
				<svg class="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
					/>
				</svg>
				<h3 class="mt-2 text-lg font-medium text-gray-900 dark:text-white">No feedback yet</h3>
				<p class="mt-1 text-sm text-gray-500">
					Configure your SDK to start capturing feedback.
				</p>
			</div>

			<FeedbackQuickSetup v-model:expanded="sdkExpanded" :script="sdkScript" />
		</div>
		<div v-else-if="feedback.length === 0" class="max-w-2xl mx-auto">
			<div role="status" class="text-center py-8">
				<h3 class="mt-2 text-lg font-medium text-gray-900 dark:text-white">No feedback matches these filters</h3>
				<p class="mt-1 text-sm text-gray-500">Try changing the search or status filter.</p>
			</div>
			<FeedbackQuickSetup v-model:expanded="sdkExpanded" :script="sdkScript" />
		</div>
		<template v-else>
			<FeedbackQuickSetup v-model:expanded="sdkExpanded" :script="sdkScript" class="mb-6" />

			<div class="card divide-y divide-gray-200 dark:divide-gray-700">
				<div
					v-for="item in feedback"
					:key="item.id"
					class="flex items-start p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
				>
					<RouterLink
						:to="`/projects/${encodeURIComponent(slug)}/feedback/${encodeURIComponent(item.id)}`"
						class="flex-1 min-w-0"
					>
						<div class="flex items-center space-x-2">
							<span :class="['badge', item.status === 'resolved' ? 'badge-success' : 'badge-info']">
								{{ item.status || 'unresolved' }}
							</span>
							<h3 class="text-sm font-medium text-gray-900 dark:text-white truncate">
								{{ item.pageTitle || 'Feedback' }}
							</h3>
						</div>
						<p class="mt-1 text-sm text-gray-600 dark:text-gray-300 truncate">
							{{ item.description }}
						</p>
						<p v-if="item.pageUrl" class="mt-1 text-xs text-gray-400 truncate">
							{{ item.pageUrl }}
						</p>
						<div class="mt-3 flex items-center space-x-2" @click.prevent>
							<button
								class="text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
								:disabled="isStatusPending(item.id)"
								@click="setFeedbackStatus(item, item.status === 'resolved' ? 'unresolved' : 'resolved')"
							>
								{{ isStatusPending(item.id) ? 'Updating…' : item.status === 'resolved' ? 'Reopen' : 'Resolve' }}
							</button>
						</div>
					</RouterLink>
					<div class="ml-4 flex flex-col items-end text-sm">
						<span v-if="item.screenshotType" class="badge badge-info">Screenshot</span>
						<time class="text-xs text-gray-400 mt-1" :datetime="item.receivedAt">
							{{ formatTime(item.receivedAt) }}
						</time>
					</div>
				</div>
			</div>
			<div v-if="hasMore" class="mt-4 text-center">
				<button class="btn btn-secondary" :disabled="loading" @click="loadFeedback(true)">
					<span v-if="loading">Loading...</span>
					<span v-else>Load More</span>
				</button>
			</div>
		</template>
	</div>
</template>
