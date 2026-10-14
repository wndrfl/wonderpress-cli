/**
 * The partial class file and its fence contract.
 *
 * A generated partial class is split into two owners. The members between the
 * `// <wonderpress:generated>` and `// </wonderpress:generated>` markers
 * ($acf_compatible, $partial_template, $properties) are machine-owned and are
 * rewritten from the manifest on every sync. Every other byte of the file is
 * the user's and survives sync untouched — custom methods belong inside the
 * class, below the closing marker.
 *
 * This module is the ONE place the class is rendered, so the writer
 * (partial.js) and drift detection (partial-drift.js) can never disagree about
 * what sync would produce. It deliberately imports nothing from partial.js:
 * partial.js imports partial-drift.js, which imports this, and a cycle there
 * would make load order matter.
 */

import fs from 'fs-extra';
import mustache from 'mustache';
import { classNameToSlug, propertiesForClassTemplate } from './validate.js';

export const FENCE_OPEN = '// <wonderpress:generated>';
export const FENCE_CLOSE = '// </wonderpress:generated>';

// A marker counts only when it is alone on its line (indentation and trailing
// whitespace aside). The same text inside a string or a longer comment is not
// a fence, so a user quoting the marker in a docblock cannot split the file.
const OPEN_LINE = /^[ \t]*\/\/ <wonderpress:generated>[ \t]*\r?$/gm;
const CLOSE_LINE = /^[ \t]*\/\/ <\/wonderpress:generated>[ \t]*\r?$/gm;

/**
 * A class file whose markers cannot be paired. Thrown rather than guessed at:
 * splicing at the wrong boundary would silently delete user code.
 */
export class FenceError extends Error {
	constructor(message, { code = 'class_fence', hint = null } = {}) {
		super(message);
		this.name = 'FenceError';
		this.code = code;
		this.hint = hint;
	}
}

function readTemplate(name) {
	return fs.readFileSync(new URL(`./templates/${name}`, import.meta.url), 'utf8');
}

function templateView(params) {
	const slug = classNameToSlug(params.class_name);
	return {
		class_name: params.class_name,
		is_acf_compatible: params.is_acf_compatible,
		has_partial_template: params.has_partial_template,
		partial_template_path: './partials/' + params.partial_template_name,
		manifest_rel_path: `.wonderpress/manifest/partials/${slug}.json`,
		sync_command: `wonderpress partial sync ${params.class_name}`,
		properties: propertiesForClassTemplate(params.properties),
	};
}

/**
 * Render the full partial class file as a fresh create (or --force) writes it.
 *
 * @param {object} params Partial params (paramsFromFlags/Json/Manifest shape).
 * @returns {string}
 */
export function renderPartialClassSource(params) {
	return mustache.render(readTemplate('partial.class.mustache'), templateView(params));
}

/**
 * Render the class as the pre-fence template produced it. Used only to decide
 * whether an unfenced (legacy) file is still exactly what sync generated, and
 * so safe to migrate without asking. The template is frozen; never edit it.
 *
 * @param {object} params
 * @returns {string}
 */
export function renderLegacyPartialClassSource(params) {
	return mustache.render(readTemplate('partial.class.legacy.mustache'), templateView(params));
}

// One `$properties` entry exactly as the legacy template printed it. Mustache
// HTML-escapes {{description}} and {{format}}, so neither can hold a raw quote.
const LEGACY_PROPERTY = /^\t\t'([a-zA-Z0-9_]+)' +=> array\(\n\t\t\t'description' => '([^'\n]*)',\n\t\t\t'format' {6}=> '([^'\n]*)',\n\t\t\t'required' {4}=> (true|false),\n\t\t\),$/gm;

/**
 * Whether an unfenced class file is byte-for-byte what the pre-fence template
 * generated for SOME params, i.e. it holds nothing a human wrote.
 *
 * Comparing against the render for the current params alone is not enough:
 * the usual reason to sync is that the manifest just changed, so a pristine
 * legacy file was generated from the previous properties. Instead the
 * generated values (ACF flag, view path, property rows) are read back out of
 * the file and re-rendered through the frozen legacy template with this
 * partial's name. Any hand-written line — a method, a comment, a reformatted
 * row — is absent from that re-render, so equality proves the file is pure
 * generator output and safe to replace.
 *
 * @param {string} source Existing file contents.
 * @param {object} params Current params (supplies the class name and paths).
 * @returns {boolean}
 */
export function isPristineLegacySource(source, params) {
	const lf = toLf(source);
	if (lf === toLf(renderLegacyPartialClassSource(params))) {
		return true;
	}
	const templateMatch = lf.match(/^\tprotected \$partial_template = '([^'\n]*)';$/m);
	const rows = [];
	LEGACY_PROPERTY.lastIndex = 0;
	let match;
	while ((match = LEGACY_PROPERTY.exec(lf)) !== null) {
		rows.push({ name: match[1], description: match[2], format: match[3], required: match[4] });
	}
	const longest = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
	const view = {
		...templateView(params),
		is_acf_compatible: /^\tprotected \$acf_compatible = true;$/m.test(lf),
		has_partial_template: !!templateMatch,
		partial_template_path: templateMatch ? templateMatch[1] : '',
		properties: rows.map((row) => ({ ...row, arrow_pad: ' '.repeat(longest - row.name.length + 1) })),
	};
	// The values were read back already escaped, so render them verbatim.
	const rerendered = mustache.render(readTemplate('partial.class.legacy.mustache'), view, {}, { escape: (s) => String(s) });
	return lf === rerendered;
}

function lineStarts(source, re) {
	re.lastIndex = 0;
	const hits = [];
	let match;
	while ((match = re.exec(source)) !== null) {
		hits.push({ index: match.index, text: match[0] });
	}
	return hits;
}

/**
 * Locate the fenced region. The region spans from the first character of the
 * opening marker (after its indentation) to the last character of the closing
 * marker, so indentation before the opening marker and the line ending after
 * the closing one stay outside, i.e. stay the user's bytes.
 *
 * @param {string} source
 * @returns {{ start: number, end: number } | null} null when the file has no markers at all.
 * @throws {FenceError} When markers exist but do not form exactly one ordered pair.
 */
export function locateFence(source) {
	const opens = lineStarts(source, OPEN_LINE);
	const closes = lineStarts(source, CLOSE_LINE);
	if (!opens.length && !closes.length) {
		return null;
	}
	if (opens.length !== 1 || closes.length !== 1) {
		throw new FenceError(
			`Expected exactly one ${FENCE_OPEN} and one ${FENCE_CLOSE} line, found ${opens.length} and ${closes.length}.`,
		);
	}
	const open = opens[0];
	const close = closes[0];
	if (close.index < open.index) {
		throw new FenceError(`${FENCE_CLOSE} appears before ${FENCE_OPEN}.`);
	}
	const start = open.index + open.text.indexOf('//');
	const closeMarkerAt = close.index + close.text.indexOf('//');
	return { start, end: closeMarkerAt + FENCE_CLOSE.length };
}

/**
 * The fenced region of a class source, markers included.
 *
 * @param {string} source
 * @returns {string | null} null when the source has no fence markers.
 * @throws {FenceError} When the markers are malformed.
 */
export function extractFencedRegion(source) {
	const at = locateFence(source);
	return at ? source.slice(at.start, at.end) : null;
}

/**
 * The fenced region sync would write for these params, markers included.
 *
 * @param {object} params
 * @returns {string}
 */
export function renderFencedRegion(params) {
	return extractFencedRegion(renderPartialClassSource(params));
}

const toLf = (s) => s.replace(/\r\n/g, '\n');

// Generated text is LF. A file checked out with CRLF (git autocrlf on Windows)
// keeps CRLF in what we splice in, so a sync never mixes line endings.
function matchEol(text, like) {
	return like.includes('\r\n') ? toLf(text).replace(/\n/g, '\r\n') : text;
}

/**
 * Compare two class sources or fenced regions, ignoring only CRLF/LF differences.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function regionsEqual(a, b) {
	return toLf(a) === toLf(b);
}

/**
 * Decide what a class write should produce, without touching disk.
 *
 * Modes:
 * - `create`   no file yet: the full fenced render.
 * - `update`   fenced file: only the fenced region is replaced; every byte
 *              outside it is kept.
 * - `unchanged` fenced file whose region already matches.
 * - `migrate`  unfenced file identical to what the pre-fence template
 *              generated (for these or earlier properties; see
 *              isPristineLegacySource): nothing custom to lose, so it is
 *              rewritten with fences.
 * - `force`    `--force`: the full fenced render, discarding the old file.
 *
 * An unfenced file that differs from the legacy render may hold hand-written
 * code, and an existing file with malformed markers cannot be spliced safely;
 * both throw a FenceError instead of guessing.
 *
 * @param {string | null} existing Current file contents, or null when absent.
 * @param {object} params
 * @param {{ force?: boolean, displayPath?: string }} [options]
 * @returns {{ mode: 'create'|'update'|'unchanged'|'migrate'|'force', source: string }}
 */
export function planPartialClassWrite(existing, params, options = {}) {
	const rendered = renderPartialClassSource(params);
	const display = options.displayPath || 'the partial class';

	if (existing === null || existing === undefined) {
		return { mode: 'create', source: rendered };
	}
	if (options.force) {
		return { mode: 'force', source: matchEol(rendered, existing) };
	}

	let at;
	try {
		at = locateFence(existing);
	} catch (err) {
		throw new FenceError(
			`Refusing to sync ${display}: its fence markers are malformed (${err.message}) so the generated region cannot be found safely. Fix the markers by hand, or re-run with --force to regenerate the whole file (custom code in it will be lost).`,
			{ code: 'class_fence', hint: `wonderpress partial sync ${params.class_name} --force` },
		);
	}

	if (at) {
		const region = matchEol(renderFencedRegion(params), existing);
		const source = existing.slice(0, at.start) + region + existing.slice(at.end);
		return { mode: source === existing ? 'unchanged' : 'update', source };
	}

	if (isPristineLegacySource(existing, params)) {
		return { mode: 'migrate', source: matchEol(rendered, existing) };
	}

	throw new FenceError(
		`Refusing to sync ${display}: it has no ${FENCE_OPEN} markers and differs from what sync generated, so it may hold custom code that a rewrite would delete. Move custom PHP aside, re-run with --force to regenerate the file with fences, then put that code back inside the class below the ${FENCE_CLOSE} line, where sync never touches it.`,
		{ code: 'class_unfenced', hint: `wonderpress partial sync ${params.class_name} --force` },
	);
}
