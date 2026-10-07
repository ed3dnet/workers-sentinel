import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('../packages/feedback-sdk/', import.meta.url));
const dashboard = fileURLToPath(new URL('../packages/dashboard/dist/', import.meta.url));
const result = spawnSync('pnpm', ['--dir', sdk, 'build'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const { version } = JSON.parse(await readFile(`${sdk}/package.json`, 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version))
	throw new Error('SDK asset version must be a release version.');
await mkdir(`${dashboard}/sdk/v${version}`, { recursive: true });
await copyFile(`${sdk}/SKILL.md`, `${dashboard}/sdk/SKILL.md`);
await copyFile(`${sdk}/dist/browser.iife.js`, `${dashboard}/sdk/feedback.js`);
await copyFile(`${sdk}/dist/browser.iife.js`, `${dashboard}/sdk/v${version}/feedback.js`);
console.log(`Feedback SDK assets: /sdk/feedback.js and /sdk/v${version}/feedback.js`);
