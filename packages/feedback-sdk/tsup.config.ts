import { defineConfig } from 'tsup';

export default defineConfig([
	{
		entry: ['src/index.ts', 'src/browser.ts'],
		format: ['esm'],
		clean: false,
		dts: true,
		noExternal: ['html-to-image'],
		target: 'es2022',
	},
	{
		entry: ['src/browser.ts'],
		format: ['iife'],
		globalName: 'WorkersSentinelFeedback',
		banner: {
			js: '/* https://wat.tilmonengineering.com/sdk/SKILL.md */',
		},
		noExternal: ['html-to-image'],
		outDir: 'dist',
		outExtension: () => ({ js: '.iife.js' }),
		splitting: false,
		target: 'es2022',
	},
]);
