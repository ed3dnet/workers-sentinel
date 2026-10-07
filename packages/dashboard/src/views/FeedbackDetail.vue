<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { api } from '../api/client';
import { useAuthStore } from '../stores/auth';

interface Feedback {
	id: string;
	description: string;
	pageUrl: string | null;
	pageTitle: string | null;
	locator: unknown;
	geometry: unknown;
	metadata?: unknown;
	receivedAt: string;
	screenshotType: string | null;
	screenshotSize: number | null;
}

const route = useRoute();
const authStore = useAuthStore();
const slug = computed(() => route.params.slug as string);
const feedbackId = computed(() => route.params.feedbackId as string);
const item = ref<Feedback | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const screenshotUrl = ref<string | null>(null);
const safePageUrl = computed(() => {
	try {
		const url = new URL(item.value?.pageUrl || '');
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
});
const screenshotLoading = ref(false);
const screenshotError = ref<string | null>(null);
let screenshotRequest = 0;
let feedbackRequest = 0;

function revokeScreenshot() {
	if (screenshotUrl.value) URL.revokeObjectURL(screenshotUrl.value);
	screenshotUrl.value = null;
}

async function loadScreenshot(id: string, projectSlug: string) {
	const requestId = ++screenshotRequest;
	revokeScreenshot();
	screenshotError.value = null;
	if (!item.value?.screenshotType) return;
	const token = authStore.token || localStorage.getItem('token');
	if (!token) {
		screenshotError.value = 'Your session has expired. Sign in again to view this screenshot.';
		return;
	}

	screenshotLoading.value = true;
	try {
		const response = await fetch(
			`/api/projects/${encodeURIComponent(projectSlug)}/feedback/${encodeURIComponent(id)}/screenshot`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!response.ok) throw new Error('Unable to load screenshot');
		const blob = await response.blob();
		if (!['image/png', 'image/jpeg', 'image/webp'].includes(blob.type))
			throw new Error('The screenshot response was not a supported raster image');
		const url = URL.createObjectURL(blob);
		if (requestId !== screenshotRequest || feedbackId.value !== id || slug.value !== projectSlug) {
			URL.revokeObjectURL(url);
			return;
		}
		screenshotUrl.value = url;
	} catch (err) {
		if (requestId === screenshotRequest) {
			screenshotError.value = err instanceof Error ? err.message : 'Unable to load screenshot';
		}
	} finally {
		if (requestId === screenshotRequest) screenshotLoading.value = false;
	}
}

async function loadFeedback() {
	const requestId = ++feedbackRequest;
	screenshotRequest++;
	screenshotLoading.value = false;
	loading.value = true;
	error.value = null;
	item.value = null;
	revokeScreenshot();
	try {
		const currentSlug = slug.value;
		const currentId = feedbackId.value;
		const response = await api.get<{ feedback: Feedback }>(
			`/api/projects/${encodeURIComponent(currentSlug)}/feedback/${encodeURIComponent(currentId)}`,
		);
		if (requestId !== feedbackRequest) return;
		item.value = response.feedback;
		await loadScreenshot(currentId, currentSlug);
	} catch (err) {
		if (requestId === feedbackRequest) {
			error.value = err instanceof Error ? err.message : 'Failed to load feedback';
		}
	} finally {
		if (requestId === feedbackRequest) loading.value = false;
	}
}

function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

onMounted(() => loadFeedback());
watch([slug, feedbackId], () => loadFeedback());
onBeforeUnmount(() => {
	feedbackRequest++;
	screenshotRequest++;
	revokeScreenshot();
});
</script>

<template>
	<section aria-labelledby="feedback-detail-heading">
		<div class="mb-6">
			<RouterLink
				:to="`/projects/${encodeURIComponent(slug)}/feedback`"
				class="mb-3 inline-block text-sm text-primary-600 hover:underline dark:text-primary-400"
			>
				← Back to feedback
			</RouterLink>
		</div>

		<div v-if="loading" role="status" class="py-12 text-center text-gray-500">
			Loading feedback…
		</div>
		<div
			v-else-if="error"
			role="alert"
			class="rounded-lg bg-error-50 px-4 py-3 text-error-700 dark:bg-error-900/20 dark:text-error-400"
		>
			{{ error }}
			<button class="ml-3 underline" @click="loadFeedback">Retry</button>
		</div>
		<article v-else-if="item" class="space-y-4">
			<header>
				<h2 id="feedback-detail-heading" class="text-xl font-bold text-gray-900 dark:text-white">
					{{ item.pageTitle || 'Feedback' }}
				</h2>
				<time class="mt-1 block text-sm text-gray-500 dark:text-gray-400" :datetime="item.receivedAt">
					{{ formatTime(item.receivedAt) }}
				</time>
			</header>

			<div class="card p-4">
				<h3 class="mb-2 font-semibold text-gray-900 dark:text-white">Description</h3>
				<p class="whitespace-pre-wrap break-words text-sm text-gray-700 dark:text-gray-300">
					{{ item.description }}
				</p>
			</div>

			<div class="card p-4">
				<h3 class="mb-2 font-semibold text-gray-900 dark:text-white">Page</h3>
				<a
					v-if="safePageUrl"
					:href="safePageUrl"
					target="_blank"
					rel="noopener noreferrer"
					class="break-all text-sm text-primary-600 hover:underline dark:text-primary-400"
				>
					{{ item.pageUrl }} <span class="sr-only">(opens in a new tab)</span>
				</a>
				<p v-else class="text-sm text-gray-500 dark:text-gray-400">No page URL was provided.</p>
			</div>

			<div v-if="item.locator != null" class="card p-4">
				<h3 class="mb-2 font-semibold text-gray-900 dark:text-white">Element</h3>
				<pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">{{ JSON.stringify(item.locator, null, 2) }}</pre>
			</div>
			<div v-if="item.geometry != null" class="card p-4">
				<h3 class="mb-2 font-semibold text-gray-900 dark:text-white">Position</h3>
				<pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">{{ JSON.stringify(item.geometry, null, 2) }}</pre>
			</div>

			<div v-if="item.metadata != null" class="card p-4">
				<h3 class="mb-2 font-semibold text-gray-900 dark:text-white">Application metadata</h3>
				<pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs text-gray-700 dark:text-gray-300">{{ JSON.stringify(item.metadata, null, 2) }}</pre>
			</div>

			<section class="card p-4" aria-labelledby="screenshot-heading">
				<h3 id="screenshot-heading" class="mb-3 font-semibold text-gray-900 dark:text-white">
					Screenshot
				</h3>
				<div v-if="!item.screenshotType" role="status" class="text-sm text-gray-500 dark:text-gray-400">
					No screenshot was included with this feedback.
				</div>
				<div v-else-if="screenshotLoading" role="status" class="text-sm text-gray-500 dark:text-gray-400">
					Loading screenshot…
				</div>
				<div v-else-if="screenshotError" role="alert" class="text-sm text-error-700 dark:text-error-400">
					{{ screenshotError }}
					<button class="ml-2 underline" @click="loadScreenshot(feedbackId, slug)">Retry screenshot</button>
				</div>
				<img
					v-else-if="screenshotUrl"
					:src="screenshotUrl"
					:alt="`Screenshot for ${item.pageTitle || 'feedback'}`"
					class="max-h-[75vh] max-w-full rounded border border-gray-200 object-contain dark:border-gray-700"
				/>
			</section>
		</article>
	</section>
</template>
