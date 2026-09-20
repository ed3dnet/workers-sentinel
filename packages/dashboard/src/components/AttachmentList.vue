<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from '../api/client';
import {
	type AttachmentMeta,
	classifyAttachment,
	downloadAttachment,
	formatBytes,
	loadAttachmentPreview,
} from '../lib/attachments';

const props = defineProps<{
	slug: string;
	eventId: string;
}>();

interface PreviewState {
	status: 'loading' | 'ready' | 'none' | 'error';
	kind?: 'text' | 'image';
	text?: string;
	url?: string;
	truncated?: boolean;
	message?: string;
}

const attachments = ref<AttachmentMeta[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const previews = ref<Record<string, PreviewState>>({});
const downloading = ref<Record<string, boolean>>({});
/** Live object URLs by attachment id, revoked on collapse/scope change. */
const liveUrls = new Map<string, string>();
/**
 * Monotonic generation: async results commit only if their generation is
 * still current, so switching events (or unmounting) mid-flight can never
 * land stale lists/previews on the new scope.
 */
let generation = 0;

function revokeUrl(attachmentId: string): void {
	const url = liveUrls.get(attachmentId);
	if (url !== undefined) {
		liveUrls.delete(attachmentId);
		URL.revokeObjectURL(url);
	}
}

function revokeAllUrls(): void {
	for (const url of liveUrls.values()) URL.revokeObjectURL(url);
	liveUrls.clear();
}

async function load(): Promise<void> {
	const run = ++generation;
	loading.value = true;
	error.value = null;
	revokeAllUrls();
	previews.value = {};
	downloading.value = {};
	try {
		const response = await api.get<{ attachments: AttachmentMeta[] }>(
			`/api/projects/${props.slug}/events/${props.eventId}/attachments`,
		);
		if (run !== generation) return;
		attachments.value = response.attachments ?? [];
	} catch (err) {
		if (run !== generation) return;
		error.value = err instanceof Error ? err.message : 'Failed to load attachments';
	} finally {
		if (run === generation) loading.value = false;
	}
}

async function togglePreview(attachment: AttachmentMeta): Promise<void> {
	const current = previews.value[attachment.id];
	if (current) {
		// collapse: release the image blob immediately (no leak on re-toggle)
		revokeUrl(attachment.id);
		delete previews.value[attachment.id];
		return;
	}
	const run = generation;
	previews.value[attachment.id] = { status: 'loading' };
	try {
		const preview = await loadAttachmentPreview(props.slug, attachment);
		if (run !== generation) {
			if (preview.kind === 'image') URL.revokeObjectURL(preview.url);
			return;
		}
		if (preview.kind === 'refused') {
			previews.value[attachment.id] = { status: 'none', message: preview.reason };
			return;
		}
		if (preview.kind === 'image') {
			liveUrls.set(attachment.id, preview.url);
			previews.value[attachment.id] = {
				status: 'ready',
				kind: 'image',
				url: preview.url,
			};
		} else {
			previews.value[attachment.id] = {
				status: 'ready',
				kind: 'text',
				text: preview.text,
				truncated: preview.truncated,
			};
		}
	} catch (err) {
		if (run !== generation) return;
		previews.value[attachment.id] = {
			status: 'error',
			message: err instanceof Error ? err.message : 'Preview failed',
		};
	}
}

async function download(attachment: AttachmentMeta): Promise<void> {
	if (downloading.value[attachment.id]) return;
	const run = generation;
	downloading.value[attachment.id] = true;
	try {
		await downloadAttachment(props.slug, attachment);
	} catch (err) {
		if (run === generation) {
			error.value = err instanceof Error ? err.message : 'Download failed';
		}
	} finally {
		if (run === generation) downloading.value[attachment.id] = false;
	}
}

function compressionBadge(filename: string): string | null {
	const cls = classifyAttachment(filename);
	return cls.compression ? cls.compression.toUpperCase() : null;
}

onMounted(() => load());
watch(
	() => [props.slug, props.eventId],
	() => {
		generation++; // invalidate in-flight loads/previews for the old scope
		revokeAllUrls();
		load();
	},
);
onBeforeUnmount(() => {
	generation++;
	revokeAllUrls();
});
</script>

<template>
	<div class="card">
		<h3 class="font-semibold text-gray-900 dark:text-white mb-3">
			Attachments
			<span v-if="attachments.length" class="text-gray-400 font-normal text-sm">({{ attachments.length }})</span>
		</h3>

		<div v-if="loading" class="text-sm text-gray-500">Loading attachments…</div>
		<div v-else-if="error" class="text-sm text-error-600 dark:text-error-400">{{ error }}</div>
		<div v-else-if="attachments.length === 0" class="text-sm text-gray-500">
			No attachments on this event.
		</div>

		<ul v-else class="space-y-3">
			<li v-for="attachment in attachments" :key="attachment.id" class="border border-gray-200 dark:border-gray-700 rounded-lg">
				<div class="flex items-center justify-between gap-3 px-3 py-2 flex-wrap">
					<div class="min-w-0 flex items-center gap-2">
						<span class="font-mono text-xs text-gray-900 dark:text-gray-100 truncate">{{ attachment.filename }}</span>
						<span
							v-if="compressionBadge(attachment.filename)"
							class="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
						>
							{{ compressionBadge(attachment.filename) }} → auto-decompressed
						</span>
						<span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
							{{ attachment.contentType }}
						</span>
						<span class="text-xs text-gray-500">{{ formatBytes(attachment.size) }}</span>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<button
							type="button"
							class="btn-secondary text-xs"
							:disabled="previews[attachment.id]?.status === 'loading'"
							@click="togglePreview(attachment)"
						>
							{{
								previews[attachment.id]?.status === 'ready'
									? 'Hide'
									: previews[attachment.id]?.status === 'loading'
										? 'Loading…'
										: 'Preview'
							}}
						</button>
						<button
							type="button"
							class="btn-secondary text-xs"
							:disabled="downloading[attachment.id]"
							@click="download(attachment)"
						>
							{{ downloading[attachment.id] ? 'Downloading…' : 'Download' }}
						</button>
					</div>
				</div>

				<div
					v-if="previews[attachment.id] && previews[attachment.id].status !== 'loading'"
					class="border-t border-gray-200 dark:border-gray-700 px-3 py-2"
				>
					<div v-if="previews[attachment.id].status === 'none'" class="text-xs text-gray-500">
						{{ previews[attachment.id].message }}
					</div>
					<div v-else-if="previews[attachment.id].status === 'error'" class="text-xs text-error-600 dark:text-error-400">
						{{ previews[attachment.id].message }}
					</div>
					<template v-else-if="previews[attachment.id].status === 'ready'">
						<img
							v-if="previews[attachment.id].kind === 'image'"
							:src="previews[attachment.id].url"
							alt="Attachment preview"
							class="max-h-96 rounded"
						/>
						<pre
							v-else
							class="text-xs font-mono overflow-x-auto whitespace-pre-wrap text-gray-900 dark:text-gray-100 max-h-96 overflow-y-auto"
							>{{ previews[attachment.id].text }}</pre
						>
						<p v-if="previews[attachment.id].truncated" class="text-xs text-amber-600 dark:text-amber-400 mt-1">
							Preview truncated at {{ formatBytes(2 * 1024 * 1024) }} — download for the full file.
						</p>
					</template>
				</div>
			</li>
		</ul>
	</div>
</template>
