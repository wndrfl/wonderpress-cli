/**
 * Pure, shared validators and parsers for CLI operations.
 *
 * Single source of truth used by the flag path, the --json path, and the
 * interactive wizard `validate` callbacks, so all three agree on what is valid.
 **/

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
