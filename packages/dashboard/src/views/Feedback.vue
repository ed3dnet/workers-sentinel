<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';

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
}

interface FeedbackPage {
	feedback: Feedback[];
	nextCursor?: string;
	hasMore: boolean;
}

const route = useRoute();
const slug = computed(() => route.params.slug as string);
const pageSize = 25;
const feedback = ref<Feedback[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const hasMore = ref(false);
const nextCursor = ref<string | undefined>();
let listRequest = 0;

async function loadFeedback(append = false) {
	const requestId = ++listRequest;
	const currentSlug = slug.value;
	loading.value = true;
	error.value = null;

	try {
		const params = new URLSearchParams({ limit: String(pageSize) });
		if (append && nextCursor.value) params.set('cursor', nextCursor.value);
		const response = await api.get<FeedbackPage>(
			`/api/projects/${encodeURIComponent(currentSlug)}/feedback?${params}`,
		);
		if (requestId !== listRequest) return;
		feedback.value = append ? [...feedback.value, ...response.feedback] : response.feedback;
		hasMore.value = response.hasMore;
		nextCursor.value = response.nextCursor;
	} catch (err) {
		if (requestId === listRequest) {
			error.value = err instanceof Error ? err.message : 'Failed to load feedback';
		}
	} finally {
		if (requestId === listRequest) loading.value = false;
	}
}

function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

onMounted(() => loadFeedback());
watch(slug, () => {
	feedback.value = [];
	nextCursor.value = undefined;
	hasMore.value = false;
	loadFeedback();
});
</script>

<template>
	<section aria-labelledby="feedback-heading">
		<div class="mb-6 flex items-center justify-between">
			<div>
				<h2 id="feedback-heading" class="text-xl font-bold text-gray-900 dark:text-white">
					Feedback
				</h2>
				<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
					Feedback submitted from this project.
				</p>
			</div>
			<button
				v-if="error"
				class="btn btn-secondary"
				:disabled="loading"
				@click="loadFeedback()"
			>
				Retry
			</button>
		</div>

		<div v-if="loading && feedback.length === 0" role="status" class="py-12 text-center text-gray-500">
			<p>Loading feedback…</p>
		</div>

		<div
			v-else-if="error"
			role="alert"
			class="rounded-lg bg-error-50 px-4 py-3 text-error-700 dark:bg-error-900/20 dark:text-error-400"
		>
			{{ error }}
		</div>

		<div v-else-if="feedback.length === 0" role="status" class="card px-6 py-12 text-center">
			<h3 class="font-medium text-gray-900 dark:text-white">No feedback yet</h3>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
				Submitted feedback will appear here.
			</p>
		</div>

		<template v-else>
			<div class="card divide-y divide-gray-200 dark:divide-gray-700">
				<RouterLink
					v-for="item in feedback"
					:key="item.id"
					:to="`/projects/${encodeURIComponent(slug)}/feedback/${encodeURIComponent(item.id)}`"
					class="block p-4 transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<h3 class="font-medium text-gray-900 dark:text-white">
								{{ item.pageTitle || 'Feedback' }}
							</h3>
							<p class="mt-1 whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">
								{{ item.description }}
							</p>
							<p v-if="item.pageUrl" class="mt-2 truncate text-xs text-gray-500 dark:text-gray-400">
								{{ item.pageUrl }}
							</p>
						</div>
						<div class="flex shrink-0 flex-col items-end gap-1 text-right">
							<time class="text-xs text-gray-500 dark:text-gray-400" :datetime="item.receivedAt">
								{{ formatTime(item.receivedAt) }}
							</time>
							<span v-if="item.screenshotType" class="badge badge-info">Screenshot</span>
						</div>
					</div>
				</RouterLink>
			</div>

			<div v-if="hasMore" class="mt-4 text-center">
				<button class="btn btn-secondary" :disabled="loading" @click="loadFeedback(true)">
					{{ loading ? 'Loading…' : 'Load more feedback' }}
				</button>
			</div>
		</template>
	</section>
</template>
