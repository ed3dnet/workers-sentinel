import DOMPurify from 'dompurify';
import { marked } from 'marked';

// GFM (tables, strikethrough) plus hard line breaks — error messages
// commonly carry meaningful newlines that soft-wrapping would hide.
marked.use({
	gfm: true,
	breaks: true,
});

// Surviving links open in a new tab: messages link out to docs, tickets,
// and source hosts, and the tracker tab should stay put.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
	const element = node as Element;
	if (element.tagName === 'A') {
		element.setAttribute('target', '_blank');
		element.setAttribute('rel', 'noopener noreferrer');
	}
});

// Conservative allowlist: text, structure, and links only. No images
// (CSP blocks remote ones anyway; data: URIs are not worth the surface),
// no inputs (GFM task-list checkboxes), no inline styles or classes.
const ALLOWED_TAGS = [
	'a',
	'blockquote',
	'br',
	'code',
	'del',
	'em',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'hr',
	'li',
	'ol',
	'p',
	'pre',
	's',
	'strong',
	'table',
	'tbody',
	'td',
	'th',
	'thead',
	'tr',
	'ul',
];

/**
 * Render untrusted markdown to sanitized HTML. Event messages are fully
 * attacker-controlled SDK input, so the markdown pass is always followed
 * by the DOMPurify allowlist pass — never one without the other. The
 * result is safe for `v-html` under the dashboard's CSP.
 */
export function renderMarkdown(source: string): string {
	const html = marked.parse(source, { async: false });
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS,
		ALLOWED_ATTR: ['href', 'title'],
	});
}
