/**
 * Pure, shared validators and parsers for CLI operations.
 *
 * Single source of truth used by the flag path, the --json path, and the
 * interactive wizard `validate` callbacks, so all three agree on what is valid.
 **/

import path from 'path';

// The property types Wonderpress can validate and render.
export const PROP_TYPES = ['array', 'boolean', 'object', 'string'];

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
 * The four PROP_TYPES all correspond 1:1 to valid block attribute types.
 **/
export const PROP_TYPE_TO_BLOCK = {
	string: 'string',
	boolean: 'boolean',
	array: 'array',
	object: 'object',
};
