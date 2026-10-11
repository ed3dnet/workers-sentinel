<script setup lang="ts">
defineProps<{ script: string; expanded: boolean }>();
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>();
</script>

<template>
	<details
		class="bg-gray-50 dark:bg-gray-700 rounded-lg p-6 mt-6"
		:open="expanded"
		@toggle="emit('update:expanded', ($event.target as HTMLDetailsElement).open)"
	>
		<summary class="cursor-pointer font-medium text-gray-900 dark:text-white mb-4">
			Quick Setup
		</summary>
		<div class="space-y-3 text-sm text-gray-600 dark:text-gray-400">
			<p>1. Load the hosted feedback SDK and install it with this project’s DSN:</p>
			<pre v-if="script" class="text-sm bg-gray-900 text-gray-100 rounded-lg p-4 overflow-x-auto mb-4"><code>{{ script }}</code></pre>
			<p v-else>Project DSN is unavailable. Check the project settings before installing the widget.</p>
			<p>
				Visitors submit feedback only when they choose. Submissions may include the description,
				page details, element position, and an optional screenshot. Avoid collecting secrets or
				personal or sensitive information, tell visitors what is collected, and obtain any
				consent your product requires.
			</p>
			<p>
				The source package or tarball may be used; public npm publication is not confirmed.
				<a class="text-primary-600 hover:underline dark:text-primary-400" href="/sdk/SKILL.md" target="_blank" rel="noopener noreferrer">Read the JavaScript SDK guide</a>.
			</p>
		</div>
	</details>
</template>
