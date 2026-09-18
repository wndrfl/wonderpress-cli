/**
 * Pure, shared validators and parsers for CLI operations.
 *
 * Single source of truth used by the flag path, the --json path, and the
 * interactive wizard `validate` callbacks, so all three agree on what is valid.
 **/

import path from 'path';

// The property types Wonderpress can validate and render.
export const PROP_TYPES = ['array', 'boolean', 'image', 'link', 'object', 'repeater', 'string'];

// What a repeater row may contain. Nested repeaters are a later slice.
export const REPEATER_SUB_TYPES = ['boolean', 'image', 'link', 'string'];

/**
 * The namespace used when a project has not recorded one of its own.
 *
 * Only a fallback. A block's namespace is written into the client's content
 * (`<!-- wp:acme/testimonial -->`), so it belongs to the project, not to the
 * tool that generated it — see resolveNamespace() in partial.js.
 **/
export const LEGACY_NAMESPACE = 'wonderpress';

/**
 * Validate a block namespace.
 *
 * WordPress requires block names to be `namespace/name`, both matching
 * /^[a-z][a-z0-9-]*$/. An invalid namespace produces a block that silently
 * fails to register, so this is checked before anything is written.
 **/
export function isValidNamespace(namespace) {
	return typeof namespace === 'string' && /^[a-z][a-z0-9-]*$/.test(namespace);
}

/**
 * Validate a partial class name (WordPress-style capitalized snake case).
 * e.g. Example_Class
 **/
export function isValidClassName(name) {
	return /^([A-Z][a-z]*)(_[A-Z][a-z]+)*$/.test(name);
}

/**
 * Validate a partial view template filename.
 * e.g. my-template.php
 **/
export function isValidTemplateName(name) {
	return /^[a-z\-]*\.php$/.test(name);
}

/**
 * Whether a property type is one Wonderpress can validate/render.
 **/
export function isValidPropType(type) {
	return PROP_TYPES.includes(type);
}

/**
 * Parse a --prop flag value of the form `name:type[:required]`.
 * Returns { name, type, required, description }; throws on malformed input.
 * e.g. quote:string:required
 **/
export function parsePropFlag(str) {
	const parts = String(str).split(':');
	const name = parts[0];
	const type = parts[1];
	const required = parts[2] === 'required' || parts[2] === 'true';

	if (!name || !type) {
		throw new Error(`Invalid --prop "${str}". Expected format: name:type[:required] (e.g. quote:string:required).`);
	}

	if (!isValidPropType(type)) {
		throw new Error(`Invalid property type "${type}" in --prop "${str}". Valid types: ${PROP_TYPES.join(', ')}.`);
	}

	return { name, type, required, description: '' };
}

/**
 * Parse a --sub flag: `parent:name:type[:required]`.
 * Attaches a sub-field to a repeater property named `parent`.
 **/
export function parseSubFlag(str) {
	const parts = String(str).split(':');
	const parent = parts[0];
	const name = parts[1];
	const type = parts[2];
	const required = parts[3] === 'required' || parts[3] === 'true';

	if (!parent || !name || !type) {
		throw new Error(`Invalid --sub "${str}". Expected format: parent:name:type[:required] (e.g. items:quote:string:required).`);
	}

	if (!REPEATER_SUB_TYPES.includes(type)) {
		throw new Error(`Invalid repeater sub-field type "${type}" in --sub "${str}". Valid types: ${REPEATER_SUB_TYPES.join(', ')}.`);
	}

	return { parent, name, type, required, description: '' };
}

/**
 * PHP $_properties format for a manifest type.
 * image / link / repeater are stored as arrays (ACF payloads / row lists).
 **/
export function phpFormatForType(type) {
	if (type === 'image' || type === 'link' || type === 'repeater') {
		return 'array';
	}
	return type;
}

/**
 * Canonical property object, including nested repeater rows.
 **/
export function normalizeProperty(p) {
	const prop = {
		name: p.name,
		type: p.type,
		required: !!p.required,
		description: p.description || '',
	};
	if (p.type === 'repeater') {
		prop.properties = (p.properties || []).map(normalizeProperty);
	}
	return prop;
}

/**
 * Convert a class name into its `class-<slug>` file basename.
 * Uses replaceAll so EVERY underscore is converted (not just the first).
 * e.g. My_Cool_Thing -> class-my-cool-thing
 **/
export function classNameToFileSlug(className) {
	return 'class-' + className.toLowerCase().replaceAll('_', '-');
}

/**
 * Default view-template filename derived from a class name.
 * e.g. My_Cool_Thing -> my-cool-thing.php
 **/
export function defaultTemplateName(className) {
	return className.toLowerCase().replaceAll('_', '-') + '.php';
}

/**
 * Bare kebab slug for a class name (no `class-` prefix, no extension).
 * Used for the block name/dir, the style partial filename, and the manifest key.
 * e.g. My_Cool_Thing -> my-cool-thing
 **/
export function classNameToSlug(className) {
	return className.toLowerCase().replaceAll('_', '-');
}

/**
 * Coerce a user-supplied component name into its kebab slug.
 * Accepts either a class name or a slug, so the CRUD commands take whichever
 * form the user has in hand.
 * e.g. Call_To_Action -> call-to-action, call-to-action -> call-to-action
 **/
export function nameToSlug(name) {
	return String(name || '').trim().toLowerCase().replaceAll('_', '-');
}

/**
 * Whether a slug is safe to build filesystem paths from.
 *
 * `nameToSlug` only lowercases and swaps underscores, so it happily returns
 * `../../etc` for a crafted name. Every path the CRUD commands derive from a
 * slug (block dir, manifest file, delegated static assets) must be built from a
 * slug that passes this.
 **/
export function isSafeSlug(slug) {
	return /^[a-z0-9-]+$/.test(String(slug || ''));
}

/**
 * Resolve `relPath` inside `rootDir`, or return null when it escapes.
 *
 * The manifest is a file on disk that the CLI deletes from, so a crafted (or
 * corrupted) artifact path like `../../../../.ssh/id_rsa` must never resolve to
 * a real removal target. Returns the absolute path when it is strictly beneath
 * `rootDir`, and null for anything else — including `rootDir` itself, which
 * would be a recursive delete of the whole theme.
 **/
export function resolveWithin(rootDir, relPath) {
	const root = path.resolve(rootDir);
	const resolved = path.resolve(root, String(relPath || ''));
	const rel = path.relative(root, resolved);

	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
		return null;
	}

	return resolved;
}

/**
 * PascalCase name for a slug, matching how Static Kit names a component's JS
 * behavior class file (`<src js>/lib/partials/<Pascal>.js`). Kept in lockstep
 * with `staticCli.component.create` so the manifest can record the path of a
 * file that Static Kit actually wrote.
 * e.g. call-to-action -> CallToAction
 **/
export function slugToPascal(slug) {
	return String(slug || '')
		.split('-')
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join('');
}

/**
 * Human-friendly title from a class name (words are already capitalized).
 * e.g. My_Cool_Thing -> "My Cool Thing"
 **/
export function humanizeClassName(className) {
	return className.replaceAll('_', ' ');
}

/**
 * Map a Wonderpress property type to a block.json attribute type.
 **/
export const PROP_TYPE_TO_BLOCK = {
	string: 'string',
	boolean: 'boolean',
	array: 'array',
	object: 'object',
	image: 'object',
	link: 'object',
	repeater: 'array',
};

/** Supported `.wonderpress/templates/*.json` schema version. */
export const TEMPLATE_MANIFEST_SCHEMA_VERSION = 1;

export const TEMPLATE_LOCK_LEVELS = ['all', 'insert', 'contentOnly', false];

const COMPOSITION_ID_RE = /^[a-z0-9-]+$/;

/**
 * Parse `--section id:partial`.
 **/
export function parseSectionFlag(str) {
	const parts = String(str).split(':');
	const id = parts[0];
	const partial = parts[1];
	if (!id || !partial || parts.length > 2) {
		throw new Error(`Invalid --section "${str}". Expected format: id:partial (e.g. hero-main:landing-hero).`);
	}
	if (!COMPOSITION_ID_RE.test(id)) {
		throw new Error(`Invalid composition id "${id}" in --section. Use lowercase letters, numbers, and hyphens.`);
	}
	if (!isSafeSlug(partial)) {
		throw new Error(`Invalid partial slug "${partial}" in --section.`);
	}
	return { id, partial };
}

/**
 * Default template manifest emitted by `template create`.
 **/
export function buildDefaultTemplateManifest(templatePhpFile, opts = {}) {
	const lock = opts.lock ?? 'all';
	if (!TEMPLATE_LOCK_LEVELS.includes(lock)) {
		throw new Error(`Invalid lock "${lock}". Use: all, insert, contentOnly, or false.`);
	}

	const composition = (opts.sections || []).map((row) => ({
		id: row.id,
		partial: row.partial,
	}));

	return {
		schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
		template: templatePhpFile,
		editor: {
			lock,
			native: {
				title: true,
				excerpt: false,
				featuredImage: false,
				discussion: false,
				blockEditor: false,
			},
		},
		composition,
	};
}

/**
 * Validate a parsed template manifest object.
 * @returns {{ ok: true, data: object } | { ok: false, errors: string[] }}
 **/
export function validateTemplateManifest(data, { partialSlugs = [] } = {}) {
	const errors = [];

	if (!data || typeof data !== 'object') {
		return { ok: false, errors: ['Manifest must be a JSON object.'] };
	}

	if (data.schemaVersion !== TEMPLATE_MANIFEST_SCHEMA_VERSION) {
		errors.push(`schemaVersion must be ${TEMPLATE_MANIFEST_SCHEMA_VERSION}.`);
	}

	if (!data.template || typeof data.template !== 'string') {
		errors.push('template is required (WordPress page template filename, e.g. template-landing.php).');
	}

	if (data.editor?.lock !== undefined && !TEMPLATE_LOCK_LEVELS.includes(data.editor.lock)) {
		errors.push('editor.lock must be all, insert, contentOnly, or false.');
	}

	const native = data.editor?.native;
	if (native !== undefined && (typeof native !== 'object' || native === null)) {
		errors.push('editor.native must be an object when present.');
	}

	const ids = new Set();
	const composition = data.composition;
	if (composition !== undefined) {
		if (!Array.isArray(composition)) {
			errors.push('composition must be an array.');
		} else {
			for (const row of composition) {
				if (!row?.id || !COMPOSITION_ID_RE.test(row.id)) {
					errors.push('Each composition row needs a valid id (a-z, 0-9, hyphen).');
					continue;
				}
				if (ids.has(row.id)) {
					errors.push(`Duplicate composition id "${row.id}".`);
				}
				ids.add(row.id);
				if (!row.partial || !isSafeSlug(row.partial)) {
					errors.push(`Composition row "${row.id}" needs a valid partial slug.`);
				} else if (partialSlugs.length && !partialSlugs.includes(row.partial)) {
					errors.push(`Composition row "${row.id}" references unknown partial "${row.partial}".`);
				}
			}
		}
	}

	if (errors.length) {
		return { ok: false, errors };
	}

	return { ok: true, data };
}
