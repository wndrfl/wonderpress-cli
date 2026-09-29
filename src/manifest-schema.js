/**
 * JSON Schema documents for WonderPress manifests.
 *
 * The editor (via a manifest's `$schema` key) uses these for completion and
 * inline errors. Enums and allowed keys come from validate.js so the editor
 * and the CLI describe the same contract. Checks that need the rest of the
 * theme — partial slugs that exist, unique composition ids — stay in
 * validate.js.
 */

import fs from 'fs-extra';
import path from 'path';
import {
	MANIFEST_ACF_PASSTHROUGH_KEYS,
	MANIFEST_SCHEMA_DIR,
	MANIFEST_WHEN_OPERATORS,
	PAGE_TEMPLATE_MANIFEST_DIR,
	PAGE_TEMPLATE_MANIFEST_SCHEMA_REF,
	PARTIAL_MANIFEST_DIR,
	PARTIAL_MANIFEST_SCHEMA_REF,
	PROP_TYPES,
	REPEATER_SUB_TYPES,
	TEMPLATE_LOCK_LEVELS,
	TEMPLATE_MANIFEST_SCHEMA_VERSION,
	TEMPLATE_TAB_PLACEMENTS,
} from './validate.js';

const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const SLUG = { type: 'string', pattern: '^[a-z0-9-]+$' };
const COMPOSITION_ID = {
	...SLUG,
	description: 'Instance id. Lowercase letters, numbers, and hyphens. Unique across the whole composition, including rows inside tabs.',
};

const ACF_KEY_SCHEMA = {
	choices: {
		type: 'object',
		additionalProperties: { type: 'string' },
		description: 'Select choices when they are not set on the property itself.',
	},
	default_value: { description: 'ACF default_value.' },
	ui: { description: 'Set to 1 for the stylized ACF control (select, true/false).' },
	return_format: { type: 'string', description: 'ACF return format, such as array, object, id, or url.' },
	preview_size: { type: 'string', description: 'Image preview size in the editor.' },
	library: { type: 'string', description: 'Image library: all or uploadedTo.' },
	layout: { type: 'string', description: 'Group or repeater layout, such as block, table, or row.' },
	wrapper: {
		type: 'object',
		additionalProperties: false,
		description: 'ACF field wrapper.',
		properties: {
			width: { type: 'string' },
			class: { type: 'string' },
			id: { type: 'string' },
		},
	},
	allow_null: { description: 'Allow an empty selection. ACF uses 1 or 0.' },
	multiple: { description: 'Allow multiple selections. ACF uses 1 or 0.' },
	placeholder: { type: 'string' },
	min: { type: 'number' },
	max: { type: 'number' },
	step: { type: 'number' },
};

const WHEN_SCHEMA = {
	type: 'array',
	minItems: 1,
	description: 'Show this field only when sibling fields match. The outer list is OR. Each inner list is AND. field is a sibling property name in this same group.',
	items: {
		type: 'array',
		minItems: 1,
		items: {
			type: 'object',
			additionalProperties: false,
			required: ['field', 'operator'],
			properties: {
				field: { type: 'string', minLength: 1, description: 'Sibling property name.' },
				operator: { enum: [...MANIFEST_WHEN_OPERATORS] },
				value: { description: 'Value to compare. ACF booleans are often the string "1".' },
			},
		},
	},
};

function acfObjectSchema() {
	const properties = {};
	for (const key of MANIFEST_ACF_PASSTHROUGH_KEYS) {
		properties[key] = ACF_KEY_SCHEMA[key] || { description: `ACF ${key}.` };
	}
	return {
		type: 'object',
		additionalProperties: false,
		description: 'ACF-only display options. format, rows, and post_type belong on the property, not in here.',
		properties,
	};
}

/**
 * One manifest property. Repeater rows use a narrower type list and do not nest.
 *
 * @param {{ types: string[], repeaterRef: string|null }} opts
 */
function propertySchema({ types, repeaterRef }) {
	const properties = {
		name: {
			type: 'string',
			minLength: 1,
			description: 'Field name. This is the ACF field name and the key on the PHP props array.',
		},
		type: {
			enum: [...types],
			description: 'How the value is stored and which editor control it gets.',
		},
		required: {
			type: 'boolean',
			description: 'Whether the editor requires a value. Not allowed on boolean, link, or partial: ACF treats a required true/false as "must be checked", and copies a required group onto every sub-field.',
		},
		description: { type: 'string', description: 'Help text. Shown as ACF instructions.' },
		label: { type: 'string', description: 'Editor label. Defaults to a title derived from name.' },
		choices: {
			type: 'object',
			minProperties: 1,
			additionalProperties: { type: 'string' },
			description: 'select only. Map of stored value to editor label.',
		},
		default: { description: 'Default value. For a select, use one of the choice keys.' },
		when: WHEN_SCHEMA,
		post_type: {
			description: 'post_object only. One post type, or a list of them.',
			oneOf: [
				{ type: 'string', minLength: 1 },
				{ type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
			],
		},
		format: {
			enum: ['text', 'textarea'],
			description: 'string only. textarea is a multi-line field.',
		},
		rows: {
			type: 'integer',
			minimum: 1,
			description: 'string only, with format textarea. Row count of the field.',
		},
		acf: acfObjectSchema(),
		partial: {
			...SLUG,
			description: 'partial only. Slug of the partial this field embeds.',
		},
	};

	if (repeaterRef) {
		properties.properties = {
			type: 'array',
			minItems: 1,
			description: 'repeater only. One level of sub-fields. A sub-field cannot itself be a repeater.',
			items: { $ref: repeaterRef },
		};
	}

	const allOf = [
		{
			if: {
				properties: { type: { const: 'select' } },
				required: ['type'],
			},
			then: {
				anyOf: [
					{ required: ['choices'] },
					{
						required: ['acf'],
						properties: { acf: { required: ['choices'] } },
					},
				],
			},
		},
		{
			if: {
				properties: { type: { const: 'partial' } },
				required: ['type'],
			},
			then: { required: ['partial'] },
		},
		{
			if: {
				properties: { type: { enum: ['boolean', 'link', 'partial'] } },
				required: ['type'],
			},
			then: {
				not: {
					properties: { required: { const: true } },
					required: ['required'],
				},
			},
		},
		forbidUnless('format', 'string'),
		forbidUnless('rows', 'string'),
		forbidUnless('post_type', 'post_object'),
		forbidUnless('partial', 'partial'),
	];

	if (repeaterRef) {
		allOf.push({
			if: {
				properties: { type: { const: 'repeater' } },
				required: ['type'],
			},
			then: { required: ['properties'] },
		});
		allOf.push(forbidUnless('properties', 'repeater'));
	}

	return {
		type: 'object',
		additionalProperties: false,
		required: ['name', 'type'],
		properties,
		allOf,
	};
}

/** Disallow `key` unless `type` is `only`. */
function forbidUnless(key, only) {
	return {
		if: {
			not: {
				properties: { type: { const: only } },
				required: ['type'],
			},
		},
		then: {
			properties: { [key]: false },
		},
	};
}

function propertyDefs() {
	return {
		property: propertySchema({
			types: PROP_TYPES,
			repeaterRef: '#/$defs/repeaterProperty',
		}),
		repeaterProperty: propertySchema({
			types: REPEATER_SUB_TYPES,
			repeaterRef: null,
		}),
	};
}

function partialInstanceSchema() {
	return {
		title: 'Partial',
		description: 'A reusable slice. Render it with wonder_partial_props( partial, id ). Its fields come from that partial\'s manifest.',
		type: 'object',
		additionalProperties: false,
		required: ['id', 'partial'],
		properties: {
			id: COMPOSITION_ID,
			label: { type: 'string', description: 'Editor label for this instance. Defaults to a title derived from id.' },
			partial: {
				...SLUG,
				description: 'Partial slug: the filename under .wonderpress/manifest/partials/, without .json.',
			},
		},
	};
}

function fieldGroupSchema() {
	return {
		title: 'Fields',
		description: 'Page-only fields. No partial and no render of its own. Read them with wonder_template_composition_field( id ) and print the HTML in the page template.',
		type: 'object',
		additionalProperties: false,
		required: ['id', 'properties'],
		properties: {
			id: COMPOSITION_ID,
			label: { type: 'string', description: 'Editor label for this group. Defaults to a title derived from id.' },
			properties: {
				type: 'array',
				minItems: 1,
				description: 'Same property shape as a partial manifest.',
				items: { $ref: '#/$defs/property' },
			},
		},
	};
}

function compositionContentSchema() {
	return {
		oneOf: [partialInstanceSchema(), fieldGroupSchema()],
	};
}

function tabSchema() {
	return {
		title: 'Tab',
		description: 'An ACF tab. Groups the rows in items. Tabs do not nest, and a tab has no PHP of its own. Placement is editor.acf.tabPlacement (left or top).',
		type: 'object',
		additionalProperties: false,
		required: ['id', 'items'],
		properties: {
			id: COMPOSITION_ID,
			label: { type: 'string', description: 'Tab label in the editor. Defaults to a title derived from id.' },
			items: {
				type: 'array',
				minItems: 1,
				description: 'Partial or fields rows inside this tab. Not another tab.',
				items: compositionContentSchema(),
			},
		},
	};
}

/**
 * Schema for `.wonderpress/manifest/partials/<slug>.json`.
 */
export function buildPartialManifestSchema() {
	return {
		$schema: DRAFT_07,
		title: 'WonderPress partial manifest',
		description: 'Contract for one partial: the fields it accepts and the files that were written for it.',
		type: 'object',
		additionalProperties: false,
		required: ['name', 'slug'],
		properties: {
			$schema: {
				const: PARTIAL_MANIFEST_SCHEMA_REF,
				description: 'Points the editor at this schema. Leave this as-is.',
			},
			name: {
				type: 'string',
				description: 'PHP class name, capitalized snake case (Headline_Stack).',
			},
			slug: {
				...SLUG,
				description: 'Kebab-case id. Matches the manifest filename.',
			},
			block: {
				type: 'string',
				description: 'Gutenberg block name (namespace/slug) when this partial is exposed as a block.',
			},
			acf_compatible: {
				type: 'boolean',
				description: 'Whether these properties are registered as ACF fields where the partial is composed.',
			},
			core_primitive: {
				type: 'boolean',
				description: 'True for a partial shipped by wonderpress-core, such as Link.',
			},
			properties: {
				type: 'array',
				description: 'Fields this partial accepts.',
				items: { $ref: '#/$defs/property' },
			},
			artifacts: {
				type: 'object',
				additionalProperties: false,
				description: 'Files written for this partial, relative to the theme.',
				required: ['class'],
				properties: {
					class: { type: 'string', description: 'PHP class file.' },
					view: { type: 'string', description: 'PHP view template.' },
					block: { type: 'string', description: 'block.json, when --block was used.' },
					render: { type: 'string', description: 'Block render.php, when --block was used.' },
					style: { type: 'string', description: 'SCSS partial, when Static Kit wrote one.' },
					script: { type: 'string', description: 'JS behavior class, when --js was used.' },
				},
			},
		},
		$defs: propertyDefs(),
	};
}

/**
 * Schema for `.wonderpress/manifest/page-templates/<template>.json`.
 */
export function buildPageTemplateManifestSchema() {
	return {
		$schema: DRAFT_07,
		title: 'WonderPress page template manifest',
		description: 'Editor contract and composition for one WordPress page template.',
		type: 'object',
		additionalProperties: false,
		required: ['schemaVersion', 'template'],
		properties: {
			$schema: {
				const: PAGE_TEMPLATE_MANIFEST_SCHEMA_REF,
				description: 'Points the editor at this schema. Leave this as-is.',
			},
			schemaVersion: {
				const: TEMPLATE_MANIFEST_SCHEMA_VERSION,
				description: 'Manifest schema version.',
			},
			template: {
				type: 'string',
				minLength: 1,
				description: 'WordPress page template filename, such as template-home.php.',
			},
			editor: {
				type: 'object',
				additionalProperties: false,
				description: 'How the editor behaves on pages that use this template.',
				properties: {
					lock: {
						enum: [...TEMPLATE_LOCK_LEVELS],
						description: 'all locks the canvas, insert blocks adding blocks, false leaves composition open.',
					},
					native: {
						type: 'object',
						additionalProperties: false,
						description: 'Which built-in editor panels appear.',
						properties: {
							title: { type: 'boolean' },
							excerpt: { type: 'boolean' },
							featuredImage: { type: 'boolean' },
							discussion: { type: 'boolean' },
							blockEditor: {
								type: 'boolean',
								description: 'false switches the page to the classic editor screen.',
							},
						},
					},
					acf: {
						type: 'object',
						additionalProperties: false,
						description: 'ACF options for the field group this template registers.',
						properties: {
							tabPlacement: {
								enum: [...TEMPLATE_TAB_PLACEMENTS],
								description: 'Where composition tabs sit. Omit to use left for one tab and top for two or more.',
							},
						},
					},
				},
			},
			composition: {
				type: 'array',
				description: 'Ordered rows. A row is a partial ({ id, partial }), page-only fields ({ id, properties }), or a tab ({ id, label, items }). A row has exactly one of partial, properties, or items.',
				items: {
					oneOf: [partialInstanceSchema(), fieldGroupSchema(), tabSchema()],
				},
			},
		},
		$defs: propertyDefs(),
	};
}

function writeIfChanged(file, body) {
	if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) {
		return false;
	}
	fs.ensureDirSync(path.dirname(file));
	fs.writeFileSync(file, body);
	return true;
}

/**
 * Write both schema files under the theme. Rewrites a file only when its
 * contents differ, so a later CLI release can refresh them.
 *
 * @param {string} themeDir Theme root.
 * @returns {string[]} Paths written or refreshed.
 */
export function ensureManifestSchemas(themeDir) {
	const dir = path.join(themeDir, MANIFEST_SCHEMA_DIR);
	const files = [
		[path.join(dir, 'partial.schema.json'), buildPartialManifestSchema()],
		[path.join(dir, 'page-template.schema.json'), buildPageTemplateManifestSchema()],
	];
	const written = [];
	for (const [file, doc] of files) {
		const body = `${JSON.stringify(doc, null, 2)}\n`;
		if (writeIfChanged(file, body)) {
			written.push(file);
		}
	}
	return written;
}

/**
 * Set `$schema` on one manifest object, keeping it the first key.
 *
 * @param {object} data Parsed manifest.
 * @param {string} ref Schema path relative to the manifest file.
 */
export function withManifestSchema(data, ref) {
	const rest = { ...data };
	delete rest.$schema;
	return { $schema: ref, ...rest };
}

function stampFile(file, ref) {
	let data;
	try {
		data = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return false;
	}
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return false;
	}
	if (data.$schema === ref) {
		return false;
	}
	fs.writeFileSync(file, `${JSON.stringify(withManifestSchema(data, ref), null, 2)}\n`);
	return true;
}

function stampDir(dir, ref) {
	if (!fs.existsSync(dir)) {
		return [];
	}
	const stamped = [];
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.json')) {
			continue;
		}
		const file = path.join(dir, name);
		if (stampFile(file, ref)) {
			stamped.push(file);
		}
	}
	return stamped;
}

/**
 * Write schema files and add `$schema` to existing partial and page-template
 * manifests that do not have it yet.
 *
 * @param {string} themeDir Theme root.
 */
export function stampManifestSchemas(themeDir) {
	ensureManifestSchemas(themeDir);
	return [
		...stampDir(path.join(themeDir, PARTIAL_MANIFEST_DIR), PARTIAL_MANIFEST_SCHEMA_REF),
		...stampDir(path.join(themeDir, PAGE_TEMPLATE_MANIFEST_DIR), PAGE_TEMPLATE_MANIFEST_SCHEMA_REF),
	];
}
