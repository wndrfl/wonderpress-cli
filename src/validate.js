/**
 * Pure, shared validators and parsers for CLI operations.
 *
 * Single source of truth used by the flag path, the --json path, and the
 * interactive wizard `validate` callbacks, so all three agree on what is valid.
 **/

import path from 'path';
import { readPartialEmbedProperties } from './partial-manifests.js';

// The property types Wonderpress can validate and render.
export const PROP_TYPES = [
	'boolean',
	'email',
	'image',
	'link',
	'partial',
	'post_object',
	'repeater',
	'select',
	'string',
];

/**
 * Property types a dual partial (ACF + block) may use today.
 * Tier B types require block inspector work — see docs/dual-authorable-types.md.
 */
export const DUAL_AUTHORABLE_TYPES = [
	'string',
	'boolean',
	'email',
	'select',
	'image',
	'link',
	'post_object',
	'repeater',
	'partial',
];

// What a repeater row may contain. Nested repeaters are a later slice.
export const REPEATER_SUB_TYPES = ['boolean', 'email', 'image', 'link', 'partial', 'select', 'string'];

/** ACF conditional operators allowed in manifest `when` rules. */
export const MANIFEST_WHEN_OPERATORS = [
	'==',
	'!=',
	'>',
	'<',
	'>=',
	'<=',
	'contains',
	'!contains',
	'pattern',
	'!pattern',
];

/**
 * Manifest keys on the property root shared by ACF and the block editor.
 * Do not nest these under `acf`.
 */
export const MANIFEST_PROPERTY_SHARED_KEYS = ['post_type', 'format', 'rows'];

/** Manifest `acf` keys that may be merged onto compiled ACF fields (ACF-only UI). */
export const MANIFEST_ACF_PASSTHROUGH_KEYS = [
	'choices',
	'default_value',
	'ui',
	'return_format',
	'preview_size',
	'library',
	'layout',
	'wrapper',
	'allow_null',
	'multiple',
	'placeholder',
	'min',
	'max',
	'step',
];

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
	if (type === 'post_object') {
		// ACF often returns WP_Post; blocks normalize to a post ID (int).
		return 'object|array|integer';
	}
	if (type === 'image' || type === 'link' || type === 'partial' || type === 'repeater') {
		return 'array';
	}
	if (type === 'select' || type === 'email') {
		return 'string';
	}
	return type;
}

/**
 * @param {string|string[]} postType
 * @returns {string[]}
 */
export function normalizePostTypeList(postType) {
	if (typeof postType === 'string') {
		return [postType];
	}
	if (Array.isArray(postType)) {
		return postType.map(String).filter(Boolean);
	}
	return [];
}

function validateManifestSharedPropertyKeys(p, errors, pathLabel) {
	if (p.acf && typeof p.acf === 'object') {
		for (const key of MANIFEST_PROPERTY_SHARED_KEYS) {
			if (Object.prototype.hasOwnProperty.call(p.acf, key)) {
				errors.push(
					`${pathLabel}: property "${p.name}" must declare "${key}" on the property root, not under acf.`,
				);
			}
		}
	}

	if (p.post_type !== undefined) {
		if (p.type !== 'post_object') {
			errors.push(`${pathLabel}: property "${p.name}" post_type is only allowed for type post_object.`);
		} else {
			const list = normalizePostTypeList(p.post_type);
			if (!list.length) {
				errors.push(`${pathLabel}: property "${p.name}" post_type must be a non-empty string or array of strings.`);
			}
		}
	}

	if (p.format !== undefined) {
		if (p.type !== 'string') {
			errors.push(`${pathLabel}: property "${p.name}" format is only allowed for type string.`);
		} else if (!['text', 'textarea'].includes(p.format)) {
			errors.push(`${pathLabel}: property "${p.name}" format must be "text" or "textarea".`);
		}
	}

	if (p.rows !== undefined) {
		if (p.type !== 'string') {
			errors.push(`${pathLabel}: property "${p.name}" rows is only allowed for type string.`);
		} else if (typeof p.rows !== 'number' || !Number.isFinite(p.rows) || p.rows < 1) {
			errors.push(`${pathLabel}: property "${p.name}" rows must be a positive number.`);
		}
	}
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
	if (p.label) {
		prop.label = p.label;
	}
	if (p.choices && typeof p.choices === 'object' && !Array.isArray(p.choices)) {
		prop.choices = p.choices;
	}
	if (p.when) {
		prop.when = p.when;
	}
	if (p.post_type !== undefined) {
		prop.post_type = normalizePostTypeList(p.post_type);
	}
	if (p.format !== undefined) {
		prop.format = p.format;
	}
	if (p.rows !== undefined) {
		prop.rows = p.rows;
	}
	if (p.acf && typeof p.acf === 'object') {
		prop.acf = p.acf;
	}
	if (p.partial) {
		prop.partial = p.partial;
	}
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
 * behavior class file (`<src js>/components/<Pascal>.js`). Kept in lockstep
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
	image: 'object',
	link: 'object',
	partial: 'object',
	repeater: 'array',
	select: 'string',
	email: 'string',
	post_object: 'object',
};

/**
 * Whether params or a saved manifest opts into both ACF and a block wrapper.
 *
 * @param {{ is_acf_compatible?: boolean, acf_compatible?: boolean, emit?: { block?: boolean }, block?: string, artifacts?: { block?: string }, properties?: object[] }} subject
 * @returns {boolean}
 */
export function isDualExposure(subject) {
	if (!subject || !Array.isArray(subject.properties)) {
		return false;
	}
	const acf = subject.is_acf_compatible === true || subject.acf_compatible === true;
	const block =
		subject.emit?.block === true ||
		(typeof subject.block === 'string' && subject.block.length > 0) ||
		(typeof subject.artifacts?.block === 'string' && subject.artifacts.block.length > 0);
	return acf && block;
}

/**
 * Dual partials may only use property types the block editor can author today.
 *
 * @param {Parameters<typeof isDualExposure>[0]} subject
 */
/**
 * @param {object} prop
 * @param {string} [pathLabel]
 * @param {{ themeDir?: string|null, visitingPartialSlugs?: Set<string> }} [ctx]
 */
function assertDualAuthorableProperty(prop, pathLabel, ctx = {}) {
	if (!prop?.name || !prop?.type) {
		return;
	}
	const label = pathLabel || prop.name;
	if (!DUAL_AUTHORABLE_TYPES.includes(prop.type)) {
		throw new Error(
			`Dual partials (--acf + --block) require dual-authorable property types. ` +
				`Property "${label}" has type "${prop.type}". Allowed: ${DUAL_AUTHORABLE_TYPES.join(', ')}. ` +
				`See docs/dual-authorable-types.md.`,
		);
	}

	if (prop.type === 'repeater') {
		const subs = Array.isArray(prop.properties) ? prop.properties : [];
		for (const sub of subs) {
			assertDualAuthorableProperty(sub, `${label}.${sub?.name || '?'}`, ctx);
		}
		return;
	}

	if (prop.type === 'partial') {
		const slug = prop.partial;
		if (!slug || !isSafeSlug(slug)) {
			throw new Error(
				`Dual partials (--acf + --block): partial property "${label}" must declare a valid partial slug.`,
			);
		}

		const visiting = ctx.visitingPartialSlugs || new Set();
		if (visiting.has(slug)) {
			throw new Error(
				`Dual partials (--acf + --block): partial embed cycle detected at "${label}" (slug "${slug}").`,
			);
		}

		visiting.add(slug);
		const refProps = readPartialEmbedProperties(ctx.themeDir ?? null, slug);
		if (!refProps?.length) {
			visiting.delete(slug);
			throw new Error(
				`Dual partials (--acf + --block): partial property "${label}" references unknown or empty partial "${slug}".`,
			);
		}

		for (const ref of refProps) {
			assertDualAuthorableProperty(ref, `${label}.${ref?.name || '?'}`, { ...ctx, visitingPartialSlugs: visiting });
		}
		visiting.delete(slug);
	}
}

export function assertDualAuthorable(subject, options = {}) {
	if (!isDualExposure(subject)) {
		return;
	}
	const ctx = {
		themeDir: options.themeDir ?? null,
		visitingPartialSlugs: new Set(),
	};
	for (const prop of subject.properties) {
		assertDualAuthorableProperty(prop, prop?.name, ctx);
	}
}

/** WonderPress manifest tree under the theme (typed by subdirectory). */
export const MANIFEST_ROOT = '.wonderpress/manifest';
export const PARTIAL_MANIFEST_DIR = `${MANIFEST_ROOT}/partials`;
export const PAGE_TEMPLATE_MANIFEST_DIR = `${MANIFEST_ROOT}/page-templates`;

/** Supported page-template manifest schema version. */
export const TEMPLATE_MANIFEST_SCHEMA_VERSION = 1;

/**
 * Path to a partial manifest file.
 **/
export function partialManifestPath(themeDir, slug) {
	return `${themeDir}/${PARTIAL_MANIFEST_DIR}/${slug}.json`;
}

/**
 * Directory for page-template manifest JSON files.
 **/
export function pageTemplateManifestDir(themeDir) {
	return `${themeDir}/${PAGE_TEMPLATE_MANIFEST_DIR}`;
}

export const TEMPLATE_LOCK_LEVELS = ['all', 'insert', false];

/** ACF tab placement for composition tab rows (`editor.acf.tabPlacement`). */
export const TEMPLATE_TAB_PLACEMENTS = ['left', 'top'];

const COMPOSITION_ID_RE = /^[a-z0-9-]+$/;

/**
 * Whether a composition row is a tab container (`items` array, no partial).
 **/
export function compositionRowIsTab(row) {
	return !!row && typeof row === 'object' && Array.isArray(row.items);
}

/**
 * Whether a composition row is an inline ACF field group (no partial).
 **/
export function compositionRowIsFieldGroup(row) {
	return (
		!!row
		&& typeof row === 'object'
		&& Array.isArray(row.properties)
		&& row.properties.length > 0
	);
}

function validateManifestAcfObject(acf, errors, pathLabel, propName) {
	if (acf === undefined) {
		return;
	}
	if (typeof acf !== 'object' || acf === null || Array.isArray(acf)) {
		errors.push(`${pathLabel}: property "${propName}" acf must be an object.`);
		return;
	}
	for (const key of Object.keys(acf)) {
		if (!MANIFEST_ACF_PASSTHROUGH_KEYS.includes(key)) {
			errors.push(`${pathLabel}: property "${propName}" has unsupported acf key "${key}".`);
		}
	}
}

function validateManifestWhen(when, errors, pathLabel, propName, siblingNames) {
	if (when === undefined) {
		return;
	}
	if (!Array.isArray(when) || !when.length) {
		errors.push(`${pathLabel}: property "${propName}" when must be a non-empty array of rule groups.`);
		return;
	}
	if (!siblingNames) {
		errors.push(`${pathLabel}: property "${propName}" when cannot be validated without sibling property names.`);
		return;
	}

	for (const andGroup of when) {
		if (!Array.isArray(andGroup) || !andGroup.length) {
			errors.push(`${pathLabel}: property "${propName}" when groups must be non-empty arrays.`);
			continue;
		}
		for (const rule of andGroup) {
			if (!rule || typeof rule !== 'object') {
				errors.push(`${pathLabel}: property "${propName}" when rules must be objects.`);
				continue;
			}
			if (!rule.field || typeof rule.field !== 'string') {
				errors.push(`${pathLabel}: property "${propName}" when rules need a field name.`);
				continue;
			}
			if (!siblingNames.has(rule.field)) {
				errors.push(
					`${pathLabel}: property "${propName}" when references unknown sibling field "${rule.field}".`,
				);
			}
			if (!rule.operator || !MANIFEST_WHEN_OPERATORS.includes(rule.operator)) {
				errors.push(
					`${pathLabel}: property "${propName}" when operator must be one of: ${MANIFEST_WHEN_OPERATORS.join(', ')}.`,
				);
			}
		}
	}
}

/**
 * Validate one manifest property; append errors instead of throwing.
 **/
function validateOneManifestProperty(p, errors, pathLabel, { asRepeaterSub = false, siblingNames = null } = {}) {
	if (!p?.name) {
		errors.push(`${pathLabel}: every property must have a name.`);
		return;
	}

	if (p.label !== undefined && typeof p.label !== 'string') {
		errors.push(`${pathLabel}: property "${p.name}" label must be a string.`);
	}

	if (!isValidPropType(p.type)) {
		errors.push(
			`${pathLabel}: invalid type "${p.type}" on property "${p.name}". Valid types: ${PROP_TYPES.join(', ')}.`,
		);
		return;
	}

	if (asRepeaterSub && !REPEATER_SUB_TYPES.includes(p.type)) {
		errors.push(
			`${pathLabel}: repeater sub-field "${p.name}" cannot be type "${p.type}". Valid types: ${REPEATER_SUB_TYPES.join(', ')}.`,
		);
		return;
	}

	if (p.type === 'select') {
		const choices = p.choices ?? p.acf?.choices;
		if (!choices || typeof choices !== 'object' || Array.isArray(choices) || !Object.keys(choices).length) {
			errors.push(`${pathLabel}: select property "${p.name}" must declare choices (object map).`);
		}
	}

	if (p.type === 'partial') {
		if (!p.partial || !isSafeSlug(p.partial)) {
			errors.push(`${pathLabel}: partial property "${p.name}" must declare a valid partial slug (partial).`);
		}
	}

	validateManifestSharedPropertyKeys(p, errors, pathLabel);
	validateManifestAcfObject(p.acf, errors, pathLabel, p.name);
	validateManifestWhen(p.when, errors, pathLabel, p.name, siblingNames);

	if (p.type === 'repeater') {
		if (!Array.isArray(p.properties) || !p.properties.length) {
			errors.push(`${pathLabel}: repeater property "${p.name}" must declare at least one sub-field.`);
			return;
		}
		const subNames = new Set(p.properties.filter((sub) => sub?.name).map((sub) => sub.name));
		for (const sub of p.properties) {
			validateOneManifestProperty(sub, errors, pathLabel, { asRepeaterSub: true, siblingNames: subNames });
		}
	}
}

/**
 * Validate manifest properties sharing one field group (sibling `when` rules).
 **/
export function validateManifestProperties(properties, errors, pathLabel, { asRepeaterSub = false } = {}) {
	if (!Array.isArray(properties)) {
		return;
	}
	const siblingNames = new Set(properties.filter((prop) => prop?.name).map((prop) => prop.name));
	for (const p of properties) {
		validateOneManifestProperty(p, errors, pathLabel, { asRepeaterSub, siblingNames });
	}
}

/**
 * Validate one manifest property. Throws on the first error.
 **/
export function validateManifestProperty(p, { asRepeaterSub = false, siblingNames = null } = {}) {
	const errors = [];
	validateOneManifestProperty(p, errors, 'Property', { asRepeaterSub, siblingNames });
	if (errors.length) {
		throw new Error(errors[0]);
	}
}

/**
 * Validate an inline `properties` array on a composition row.
 **/
function validateCompositionProperties(properties, errors, pathLabel) {
	if (!Array.isArray(properties) || !properties.length) {
		errors.push(`${pathLabel} needs a non-empty properties array.`);
		return;
	}

	validateManifestProperties(properties, errors, pathLabel);
}

/**
 * Instance rows only, in document order (root and tab children).
 **/
export function flattenTemplateComposition(composition) {
	if (!Array.isArray(composition)) {
		return [];
	}

	const flat = [];
	for (const row of composition) {
		if (!row || typeof row !== 'object') {
			continue;
		}

		if (compositionRowIsTab(row)) {
			for (const child of row.items) {
				if (child && typeof child === 'object' && child.partial && !compositionRowIsTab(child)) {
					flat.push(child);
				}
			}
			continue;
		}

		if (row.partial) {
			flat.push(row);
		}
	}

	return flat;
}

/**
 * Validate a partial instance or inline field-group row (root or tab child).
 **/
function validateCompositionContentRow(row, ids, errors, partialSlugs, pathLabel) {
	if (!row?.id || !COMPOSITION_ID_RE.test(row.id)) {
		errors.push(`${pathLabel} needs a valid id (a-z, 0-9, hyphen).`);
		return;
	}

	if (ids.has(row.id)) {
		errors.push(`Duplicate composition id "${row.id}".`);
	}
	ids.add(row.id);

	const hasPartial = !!row.partial;
	const hasProperties = compositionRowIsFieldGroup(row);
	const hasItems = compositionRowIsTab(row);

	if (hasPartial && hasProperties) {
		errors.push(`Composition row "${row.id}" cannot have both partial and properties.`);
		return;
	}

	if (hasPartial && hasItems) {
		errors.push(`Composition row "${row.id}" cannot have both partial and items.`);
		return;
	}

	if (hasProperties && hasItems) {
		errors.push(`Composition row "${row.id}" cannot have both properties and items.`);
		return;
	}

	if (hasProperties) {
		validateCompositionProperties(row.properties, errors, pathLabel);
		return;
	}

	if (!hasPartial) {
		errors.push(`Composition row "${row.id}" needs a partial slug or properties array.`);
		return;
	}

	if (!isSafeSlug(row.partial)) {
		errors.push(`Composition row "${row.id}" needs a valid partial slug.`);
	} else if (partialSlugs.length && !partialSlugs.includes(row.partial)) {
		errors.push(`Composition row "${row.id}" references unknown partial "${row.partial}".`);
	}
}

/**
 * Validate template composition (flat instances and tab containers).
 **/
export function validateTemplateComposition(composition, { partialSlugs = [] } = {}) {
	const errors = [];

	if (composition === undefined) {
		return errors;
	}

	if (!Array.isArray(composition)) {
		errors.push('composition must be an array.');
		return errors;
	}

	const ids = new Set();

	for (const row of composition) {
		if (!row?.id || !COMPOSITION_ID_RE.test(row.id)) {
			errors.push('Each composition row needs a valid id (a-z, 0-9, hyphen).');
			continue;
		}

		const hasPartial = !!row.partial;
		const hasProperties = compositionRowIsFieldGroup(row);
		const hasItems = compositionRowIsTab(row);

		if (hasPartial && hasItems) {
			errors.push(`Composition row "${row.id}" cannot have both partial and items.`);
			continue;
		}

		if (hasProperties && hasItems) {
			errors.push(`Composition row "${row.id}" cannot have both properties and items.`);
			continue;
		}

		if (hasPartial && hasProperties) {
			errors.push(`Composition row "${row.id}" cannot have both partial and properties.`);
			continue;
		}

		if (hasItems) {
			if (ids.has(row.id)) {
				errors.push(`Duplicate composition id "${row.id}".`);
			}
			ids.add(row.id);

			if (!row.items.length) {
				errors.push(`Tab row "${row.id}" must include at least one item.`);
				continue;
			}

			for (const child of row.items) {
				if (compositionRowIsTab(child)) {
					errors.push(`Tab row "${row.id}" cannot nest another tab.`);
					continue;
				}
				validateCompositionContentRow(
					child,
					ids,
					errors,
					partialSlugs,
					`Composition item under tab "${row.id}"`,
				);
			}
			continue;
		}

		if (hasPartial || hasProperties) {
			validateCompositionContentRow(row, ids, errors, partialSlugs, `Composition row "${row.id}"`);
			continue;
		}

		errors.push(`Composition row "${row.id}" needs partial, properties, or items (tab).`);
	}

	return errors;
}

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
		throw new Error(`Invalid lock "${lock}". Use: all, insert, or false.`);
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
		errors.push('editor.lock must be all, insert, or false.');
	}

	const native = data.editor?.native;
	if (native !== undefined && (typeof native !== 'object' || native === null)) {
		errors.push('editor.native must be an object when present.');
	}

	const editorAcf = data.editor?.acf;
	if (editorAcf !== undefined && (typeof editorAcf !== 'object' || editorAcf === null)) {
		errors.push('editor.acf must be an object when present.');
	}

	if (
		editorAcf?.tabPlacement !== undefined
		&& !TEMPLATE_TAB_PLACEMENTS.includes(editorAcf.tabPlacement)
	) {
		errors.push('editor.acf.tabPlacement must be left or top.');
	}

	errors.push(...validateTemplateComposition(data.composition, { partialSlugs }));

	if (errors.length) {
		return { ok: false, errors };
	}

	return { ok: true, data };
}
