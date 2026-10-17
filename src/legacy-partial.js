/**
 * Legacy (pre-manifest) partial classes: how `theme migrate` reads them.
 *
 * Before manifests, a partial was one hand-written PHP class under
 * `src/partials/class-<slug>.php`:
 *
 *   namespace Wonderpress\Partials;
 *   class Theme_Text_Stack extends Abstract_Partial {
 *       protected $_acf_compatible = true;                       // sometimes
 *       protected $_partial_template = './partials/theme-text-stack.php';
 *       protected static $_properties = array(
 *           'headline' => array(
 *               'description' => 'The text for the headline',
 *               'format'      => 'string',
 *               'required'    => false,
 *           ),
 *       );
 *       public function some_helper() { ... }                   // sometimes
 *   }
 *
 * The contract a manifest needs (name, view, properties) is all in there, but
 * in PHP. This module reads it back out without executing PHP: a small,
 * tolerant parser for the `$_properties` array literal (and the two scalar
 * members beside it), plus the mapping from a legacy `format` string to a
 * manifest property type. Nothing here writes; theme.js owns the command.
 *
 * Like partial-class.js, this imports nothing from partial.js, so it can be
 * used by anything that already imports partial.js without a cycle.
 */

import fs from 'fs-extra';
import path from 'path';
import {
	classNameToSlug,
	isValidTemplateName,
	PARTIAL_MANIFEST_DIR,
	PROP_TYPES,
	REQUIRED_FORBIDDEN_TYPES,
} from './validate.js';
import { FENCE_CLOSE, locateFence, renderPartialClassSource } from './partial-class.js';

/** Where a legacy theme keeps its partial classes, theme-relative. */
export const LEGACY_CLASS_DIR = 'src/partials';

/** Where a legacy theme keeps ACF block render files, theme-relative. Never touched. */
export const ACF_BLOCK_DIR = 'partials/blocks';

/** The original class is kept beside the regenerated one under this suffix. */
export const LEGACY_BACKUP_SUFFIX = '.legacy';

// --- a tolerant PHP value parser ------------------------------------------

/**
 * Thrown when the `$_properties` literal cannot be read. Carries the offset
 * so the message can point at a line.
 */
export class PhpParseError extends Error {
	constructor(message, offset) {
		super(message);
		this.name = 'PhpParseError';
		this.offset = offset;
	}
}

/**
 * Parse one PHP value starting at `start` in `source`.
 *
 * Understands what a property table is made of: `array( ... )` and `[ ... ]`
 * (keyed or not, trailing comma allowed), single- and double-quoted strings
 * with backslash escapes, true/false/null in any case, and numbers. Anything
 * else (a constant, a `__()` call, `self::X`) is kept verbatim as
 * `{ raw: '<text>' }` rather than rejected, so one unusual value does not
 * hide the rest of the table. Comments between tokens are skipped.
 *
 * Arrays come back as `{ entries: [{ key, value }] }` in source order, with
 * `key` null for unkeyed items; `toPlainObject()` turns one into an object.
 *
 * @param {string} source
 * @param {number} [start]
 * @returns {{ value: unknown, end: number }} `end` is the index just past the value.
 * @throws {PhpParseError}
 */
export function parsePhpValue(source, start = 0) {
	let pos = start;

	const fail = (message) => {
		throw new PhpParseError(`${message} at offset ${pos}`, pos);
	};

	const skip = () => {
		for (;;) {
			const ch = source[pos];
			if (ch === undefined) {
				return;
			}
			if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
				pos += 1;
			} else if (ch === '#' || (ch === '/' && source[pos + 1] === '/')) {
				while (pos < source.length && source[pos] !== '\n') {
					pos += 1;
				}
			} else if (ch === '/' && source[pos + 1] === '*') {
				const close = source.indexOf('*/', pos + 2);
				pos = close === -1 ? source.length : close + 2;
			} else {
				return;
			}
		}
	};

	const readString = (quote) => {
		let out = '';
		pos += 1; // opening quote
		for (;;) {
			const ch = source[pos];
			if (ch === undefined) {
				fail('Unterminated string');
			}
			if (ch === '\\') {
				const next = source[pos + 1];
				if (quote === "'") {
					// Only \' and \\ are escapes in a single-quoted PHP string.
					if (next === "'" || next === '\\') {
						out += next;
						pos += 2;
					} else {
						out += ch;
						pos += 1;
					}
				} else {
					const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', $: '$' };
					out += next in map ? map[next] : ch + (next ?? '');
					pos += 2;
				}
				continue;
			}
			if (ch === quote) {
				pos += 1;
				return out;
			}
			out += ch;
			pos += 1;
		}
	};

	const readRaw = () => {
		// Up to the next top-level `,`, `)` or `]`, balancing what is inside.
		const from = pos;
		let depth = 0;
		while (pos < source.length) {
			const ch = source[pos];
			if (ch === "'" || ch === '"') {
				readString(ch);
				continue;
			}
			if (ch === '(' || ch === '[') {
				depth += 1;
			} else if (ch === ')' || ch === ']') {
				if (depth === 0) {
					break;
				}
				depth -= 1;
			} else if (ch === ',' && depth === 0) {
				break;
			}
			pos += 1;
		}
		const raw = source.slice(from, pos).trim();
		if (!raw) {
			fail('Expected a value');
		}
		return { raw };
	};

	const readArray = (close) => {
		const entries = [];
		for (;;) {
			skip();
			if (source[pos] === close) {
				pos += 1;
				return { entries };
			}
			if (pos >= source.length) {
				fail(`Unterminated array (missing "${close}")`);
			}
			const first = readValue();
			skip();
			let entry;
			if (source.startsWith('=>', pos)) {
				pos += 2;
				skip();
				entry = { key: first, value: readValue() };
			} else {
				entry = { key: null, value: first };
			}
			entries.push(entry);
			skip();
			if (source[pos] === ',') {
				pos += 1;
				continue;
			}
			if (source[pos] === close) {
				pos += 1;
				return { entries };
			}
			if (pos >= source.length) {
				fail(`Unterminated array (missing "${close}")`);
			}
			fail(`Expected "," or "${close}" in array`);
		}
	};

	const readValue = () => {
		skip();
		const ch = source[pos];
		if (ch === undefined) {
			fail('Unexpected end of input');
		}
		if (ch === "'" || ch === '"') {
			return readString(ch);
		}
		if (ch === '[') {
			pos += 1;
			return readArray(']');
		}
		const arrayCall = /^array\s*\(/i.exec(source.slice(pos, pos + 16));
		if (arrayCall) {
			pos += arrayCall[0].length;
			return readArray(')');
		}
		const word = /^(true|false|null)\b/i.exec(source.slice(pos, pos + 6));
		if (word) {
			pos += word[0].length;
			const lower = word[1].toLowerCase();
			return lower === 'true' ? true : lower === 'false' ? false : null;
		}
		const number = /^-?\d+(\.\d+)?/.exec(source.slice(pos, pos + 32));
		if (number) {
			pos += number[0].length;
			return Number(number[0]);
		}
		return readRaw();
	};

	const value = readValue();
	return { value, end: pos };
}

/**
 * A parsed PHP array as a plain object (keyed entries) or JS array (unkeyed).
 * Nested arrays convert too. Non-array values pass through.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function toPlainObject(value) {
	if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) {
		return value;
	}
	const keyed = value.entries.some((e) => e.key !== null);
	if (!keyed) {
		return value.entries.map((e) => toPlainObject(e.value));
	}
	const out = {};
	let index = 0;
	for (const entry of value.entries) {
		const key = entry.key === null ? index : entry.key;
		index = typeof key === 'number' ? key + 1 : index;
		out[String(key)] = toPlainObject(entry.value);
	}
	return out;
}

// --- reading a legacy class file -------------------------------------------

/**
 * Find a `protected [static] $name = <value>;` member and its surrounding
 * docblock. Returns the span (so it can be cut out of the body) and the raw
 * value text, or null when the class has no such member.
 *
 * @param {string} source
 * @param {string[]} names Variable names to accept, without the `$`.
 * @returns {{ name: string, start: number, end: number, valueStart: number } | null}
 */
function findMember(source, names) {
	const alternatives = names.map((n) => n.replace(/[$_]/g, (c) => `\\${c}`)).join('|');
	const re = new RegExp(`^[ \\t]*(?:public|protected|private)?[ \\t]*(?:static[ \\t]+)?(?:public|protected|private)?[ \\t]*\\$(${alternatives})[ \\t]*=[ \\t]*`, 'm');
	const match = re.exec(source);
	if (!match) {
		return null;
	}
	let start = match.index;
	// Take the docblock above when only whitespace separates them.
	const before = source.slice(0, start);
	// The nearest docblock, and only when nothing but whitespace sits
	// between its end and the member (so a file header is never taken).
	const docAt = before.lastIndexOf('/**');
	const doc = docAt !== -1 && /^\/\*\*[\s\S]*?\*\/[ \t]*\r?\n[ \t]*$/.test(before.slice(docAt)) ? docAt : -1;
	if (doc !== -1) {
		start = doc;
		// Keep the indentation that preceded the docblock out of the span
		// only when it is on the docblock's own line.
		const lineStart = before.lastIndexOf('\n', doc - 1) + 1;
		if (!before.slice(lineStart, doc).trim()) {
			start = lineStart;
		}
	} else {
		const lineStart = before.lastIndexOf('\n') + 1;
		if (!before.slice(lineStart).trim()) {
			start = lineStart;
		}
	}
	return { name: match[1], start, end: match.index + match[0].length, valueStart: match.index + match[0].length };
}

/**
 * Extend a member span past its value and the `;` (and the line ending).
 *
 * @param {string} source
 * @param {{ start: number, valueStart: number }} member
 * @returns {{ value: unknown, start: number, end: number }}
 */
function readMember(source, member) {
	const { value, end } = parsePhpValue(source, member.valueStart);
	let cursor = end;
	while (cursor < source.length && /[ \t\r\n]/.test(source[cursor])) {
		cursor += 1;
	}
	if (source[cursor] !== ';') {
		throw new PhpParseError(`Expected ";" after $${member.name} at offset ${cursor}`, cursor);
	}
	cursor += 1;
	// Swallow the rest of the line so the cut leaves no blank line behind.
	const eol = source.indexOf('\n', cursor);
	if (eol !== -1 && !source.slice(cursor, eol).trim()) {
		cursor = eol + 1;
	}
	return { value, start: member.start, end: cursor };
}

/**
 * Read a legacy partial class file into the pieces a migration needs.
 *
 * - `className`, `parent` (as written after `extends`, may be aliased), `uses`
 *   (the file's `use` lines, verbatim).
 * - `viewPath`: `$_partial_template` normalized to a theme-relative posix
 *   path (`./partials/x.php` -> `partials/x.php`), or null when the class
 *   declares none / `false`.
 * - `acfCompatible`: the legacy `$_acf_compatible` flag.
 * - `properties`: `[{ name, spec }]` in declaration order, `spec` being the
 *   plain object of the row (`description`, `format`, `required`, anything
 *   else kept as is). An empty or missing table gives `[]`.
 * - `customBody`: the class body with the three generated members cut out,
 *   trimmed of blank lines: what a migration must preserve. '' when nothing.
 * - `fenced`: whether the file already carries `<wonderpress:generated>` markers.
 *
 * @param {string} source
 * @returns {object}
 * @throws {PhpParseError|Error} When there is no class, or a member cannot be read.
 */
export function parseLegacyClass(source) {
	const classMatch = /^[ \t]*(?:abstract[ \t]+|final[ \t]+)?class[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+extends[ \t]+([A-Za-z_\\][A-Za-z0-9_\\]*))?[^{]*\{/m.exec(source);
	if (!classMatch) {
		throw new Error('No class declaration found.');
	}
	const className = classMatch[1];
	const parent = classMatch[2] || null;
	const bodyStart = classMatch.index + classMatch[0].length;
	const bodyEnd = source.lastIndexOf('}');
	if (bodyEnd < bodyStart) {
		throw new Error(`Class ${className} has no closing brace.`);
	}

	const uses = [];
	const useRe = /^[ \t]*use[ \t]+[^;]+;[ \t]*$/gm;
	let useMatch;
	while ((useMatch = useRe.exec(source.slice(0, classMatch.index))) !== null) {
		uses.push(useMatch[0].trim());
	}

	let fenced = false;
	try {
		fenced = locateFence(source) !== null;
	} catch {
		fenced = true;
	}

	const spans = [];
	const take = (names) => {
		const found = findMember(source, names);
		if (!found || found.start < bodyStart || found.start > bodyEnd) {
			return undefined;
		}
		const read = readMember(source, found);
		spans.push({ start: read.start, end: read.end });
		return read.value;
	};

	const template = take(['_partial_template', 'partial_template']);
	const acf = take(['_acf_compatible', 'acf_compatible']);
	const table = take(['_properties', 'properties']);

	let viewPath = null;
	if (typeof template === 'string' && template.trim()) {
		viewPath = template.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
	}

	const properties = [];
	if (table && typeof table === 'object' && Array.isArray(table.entries)) {
		for (const entry of table.entries) {
			if (typeof entry.key !== 'string') {
				continue;
			}
			const spec = toPlainObject(entry.value);
			properties.push({
				name: entry.key,
				spec: spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {},
			});
		}
	}

	// The body minus the generated members, cut from the end so earlier
	// offsets stay valid.
	let body = source.slice(bodyStart, bodyEnd);
	for (const span of spans.sort((a, b) => b.start - a.start)) {
		body = body.slice(0, span.start - bodyStart) + body.slice(span.end - bodyStart);
	}
	const customBody = body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');

	return {
		className,
		parent,
		uses,
		viewPath,
		acfCompatible: acf === true,
		properties,
		customBody,
		fenced,
	};
}

// --- mapping to the manifest --------------------------------------------------

/**
 * Manifest type for a legacy `format`, and whether a human should look at it.
 *
 * `string` and `boolean` carry over. `object` was how the old classes said
 * "a WP_Post" nearly every time, so it becomes `post_object`, flagged because
 * it may have been some other object. `array`, `string|array` and anything
 * unrecognised have no single manifest type; they default to `string` and
 * are flagged so the migration stops until `--type` settles them.
 *
 * @param {string | null} format Lowercased legacy format, or null when absent.
 * @returns {{ type: string, review: boolean, reason: string | null }}
 */
export function mapLegacyFormat(format) {
	switch (format) {
		case 'string':
			return { type: 'string', review: false, reason: null };
		case 'boolean':
		case 'bool':
			return { type: 'boolean', review: false, reason: null };
		case 'object':
			return {
				type: 'post_object',
				review: true,
				reason: "legacy format 'object' is assumed to be a post (post_object); confirm, or choose another type",
			};
		case null:
			return { type: 'string', review: true, reason: 'no legacy format declared; defaulted to string' };
		default:
			return {
				type: 'string',
				review: true,
				reason: `legacy format '${format}' has no single manifest type; defaulted to string`,
			};
	}
}

/**
 * One legacy property row as a manifest property plus its migration report.
 *
 * @param {{ name: string, spec: object }} row
 * @param {string | undefined} override A `--type` for this property, already validated.
 * @returns {{ property: object, report: { name: string, type: string, source: string, review: boolean, note: string | null } }}
 */
export function migrateProperty(row, override) {
	const spec = row.spec || {};
	const format = typeof spec.format === 'string' && spec.format.trim() ? spec.format.trim().toLowerCase() : null;
	const notes = [];

	let type;
	let review = false;
	let source;
	if (override) {
		type = override;
		source = 'override';
		notes.push(`type set to ${override} by --type (legacy format: ${format ?? 'none'})`);
	} else {
		const mapped = mapLegacyFormat(format);
		type = mapped.type;
		review = mapped.review;
		source = `format:${format ?? 'none'}`;
		if (mapped.reason) {
			notes.push(`${mapped.reason}; pass --type ${row.name}=<type> to decide`);
		}
	}

	let required = spec.required === true;
	if (required && REQUIRED_FORBIDDEN_TYPES.includes(type)) {
		required = false;
		notes.push(`required dropped: a ${type} property cannot be required`);
	}

	let description = '';
	if (typeof spec.description === 'string') {
		description = spec.description;
	} else if (spec.description !== undefined) {
		notes.push('description was not a plain string and was dropped');
	}

	if (spec.default !== undefined) {
		notes.push(`default ${JSON.stringify(spec.default)} dropped: manifests carry no defaults, apply it in the view`);
	}

	return {
		property: { name: row.name, type, required, description },
		report: { name: row.name, type, source, review, note: notes.length ? notes.join('. ') : null },
	};
}

/**
 * Parse `--type name=type` flags. Throws a usage-style Error for a malformed
 * flag, an unknown type, or a name the class does not declare.
 *
 * @param {string[] | undefined} flags
 * @param {string[]} knownNames
 * @returns {Record<string, string>}
 */
export function parseTypeOverrides(flags, knownNames) {
	const out = {};
	for (const flag of flags || []) {
		const at = String(flag).indexOf('=');
		const name = at === -1 ? '' : flag.slice(0, at).trim();
		const type = at === -1 ? '' : flag.slice(at + 1).trim();
		if (!name || !type) {
			throw new Error(`Malformed --type "${flag}": expected name=type.`);
		}
		if (!PROP_TYPES.includes(type)) {
			throw new Error(`Invalid type "${type}" in --type "${flag}". Valid types: ${PROP_TYPES.join(', ')}.`);
		}
		if (!knownNames.includes(name)) {
			throw new Error(`--type names "${name}", which the legacy class does not declare. Properties: ${knownNames.join(', ') || '(none)'}.`);
		}
		out[name] = type;
	}
	return out;
}

/**
 * Plan a migration for one parsed legacy class: the params `partial sync`
 * would consume, the per-property report, the notes about everything else,
 * and whether a human decision is still outstanding.
 *
 * `blockers` are review items `--type` cannot settle (a view outside
 * `partials/`); `review` is true when any property is flagged or a blocker
 * exists. Apply refuses while `review` is true.
 *
 * @param {object} legacy parseLegacyClass() output.
 * @param {{ overrides?: Record<string, string> }} [options]
 * @returns {{ params: object, slug: string, properties: object[], notes: string[], blockers: string[], review: boolean, viewPath: string | null }}
 */
export function planMigration(legacy, options = {}) {
	const overrides = options.overrides || {};
	const notes = [];
	const blockers = [];
	const reports = [];
	const properties = [];

	for (const row of legacy.properties) {
		const { property, report } = migrateProperty(row, overrides[row.name]);
		properties.push(property);
		reports.push(report);
	}

	let viewName = null;
	if (legacy.viewPath) {
		const base = path.posix.basename(legacy.viewPath);
		if (legacy.viewPath !== `partials/${base}`) {
			blockers.push(`view ${legacy.viewPath} is not directly under partials/; the regenerated class would point at ./partials/${base}. Move the view there first.`);
		} else if (!isValidTemplateName(base)) {
			blockers.push(`view ${legacy.viewPath} is not a valid template name (lowercase letters and dashes, ending .php); rename it first.`);
		} else {
			viewName = base;
		}
	} else {
		notes.push('no $_partial_template: the manifest records no view; whatever renders this partial stays in the preserved class body');
	}

	if (legacy.acfCompatible) {
		notes.push('legacy class declared $_acf_compatible = true; the manifest records acf_compatible false. Set it to true by hand once the property types are confirmed');
	}
	if (legacy.parent && !/(^|\\)Abstract_Partial$/.test(legacy.parent)) {
		notes.push(`class extends ${legacy.parent}, not Abstract_Partial; the parent and its use statement are kept`);
	}
	if (legacy.customBody) {
		notes.push('custom members found in the class; they are preserved below the generated region');
	}
	if (legacy.fenced) {
		notes.push('class already carries <wonderpress:generated> markers but has no manifest; it is treated as legacy');
	}

	const params = {
		class_name: legacy.className,
		is_acf_compatible: false,
		has_partial_template: !!viewName,
		partial_template_name: viewName || undefined,
		properties,
		emit: { block: false, manifest: true, style: !!viewName, script: false },
	};

	return {
		params,
		slug: classNameToSlug(legacy.className),
		properties: reports,
		notes,
		blockers,
		review: blockers.length > 0 || reports.some((r) => r.review),
		viewPath: legacy.viewPath,
	};
}

/**
 * The regenerated class: the fenced template `partial create` writes, with
 * the legacy file's parent class, extra `use` lines and custom members kept.
 *
 * The fenced region is exactly `renderFencedRegion(params)`, so after the
 * write check-drift reads clean and `partial sync` replaces only the region.
 *
 * @param {object} params
 * @param {object} legacy parseLegacyClass() output.
 * @returns {string}
 */
export function renderMigratedClass(params, legacy) {
	let source = renderPartialClassSource(params);

	if (legacy.parent && !/(^|\\)Abstract_Partial$/.test(legacy.parent)) {
		source = source.replace(
			new RegExp(`^class ${legacy.className} extends Abstract_Partial \\{`, 'm'),
			`class ${legacy.className} extends ${legacy.parent} {`,
		);
	}

	const templateUse = 'use Wonderpress_Core\\Partials\\Abstract_Partial;';
	const extraUses = legacy.uses.filter((line) => line !== templateUse && !source.includes(line));
	if (extraUses.length) {
		source = source.replace(`${templateUse}\n`, `${templateUse}\n${extraUses.join('\n')}\n`);
	}

	if (legacy.customBody) {
		const marker = `\t${FENCE_CLOSE}\n`;
		source = source.replace(marker, `${marker}\n${legacy.customBody}\n`);
	}

	return source;
}

// --- the inventory ----------------------------------------------------------

/**
 * Every `src/partials/class-*.php` and `partials/blocks/*.php` in a theme,
 * with the status `theme migrate --list` reports.
 *
 * Classes: `ready` when every legacy format maps without a decision,
 * `review` when one does not (or the file could not be parsed, with the
 * error in `error`), `migrated` when a manifest exists for the slug. ACF
 * blocks are listed with kind `acf-block` and status `not migrated`: they
 * are out of scope and never touched.
 *
 * @param {string} themeDir
 * @returns {Array<object>}
 */
export function inventoryLegacyPartials(themeDir) {
	const out = [];

	const classDir = path.join(themeDir, LEGACY_CLASS_DIR);
	if (fs.existsSync(classDir)) {
		for (const file of fs.readdirSync(classDir).sort()) {
			if (!/^class-.*\.php$/.test(file)) {
				continue;
			}
			const classPath = `${LEGACY_CLASS_DIR}/${file}`;
			const entry = { kind: 'class', classPath, slug: file.replace(/^class-/, '').replace(/\.php$/, '') };
			let legacy;
			try {
				legacy = parseLegacyClass(fs.readFileSync(path.join(classDir, file), 'utf8'));
			} catch (err) {
				out.push({ ...entry, className: null, viewPath: null, properties: 0, status: 'review', error: err.message });
				continue;
			}
			const plan = planMigration(legacy);
			const slug = plan.slug;
			const migrated = fs.existsSync(path.join(themeDir, PARTIAL_MANIFEST_DIR, `${slug}.json`));
			out.push({
				...entry,
				slug,
				className: legacy.className,
				viewPath: legacy.viewPath,
				properties: legacy.properties.length,
				status: migrated ? 'migrated' : (plan.review ? 'review' : 'ready'),
			});
		}
	}

	const blockDir = path.join(themeDir, ACF_BLOCK_DIR);
	if (fs.existsSync(blockDir)) {
		for (const file of fs.readdirSync(blockDir).sort()) {
			if (!file.endsWith('.php')) {
				continue;
			}
			out.push({
				kind: 'acf-block',
				slug: file.replace(/\.php$/, ''),
				path: `${ACF_BLOCK_DIR}/${file}`,
				status: 'not migrated',
			});
		}
	}

	return out;
}
