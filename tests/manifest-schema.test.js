import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { writeManifest } from '../src/partial.js';
import {
	buildPageTemplateManifestSchema,
	buildPartialManifestSchema,
	ensureManifestSchemas,
	stampManifestSchemas,
	withManifestSchema,
} from '../src/manifest-schema.js';
import {
	MANIFEST_ACF_PASSTHROUGH_KEYS,
	MANIFEST_WHEN_OPERATORS,
	PAGE_TEMPLATE_MANIFEST_SCHEMA_REF,
	PARTIAL_MANIFEST_SCHEMA_REF,
	PROP_TYPES,
	REPEATER_SUB_TYPES,
	TEMPLATE_LOCK_LEVELS,
	TEMPLATE_MANIFEST_SCHEMA_VERSION,
	TEMPLATE_TAB_PLACEMENTS,
	buildDefaultTemplateManifest,
} from '../src/validate.js';

function tmpTheme() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-manifest-schema-'));
}

test('partial schema enums match the CLI validator', () => {
	const schema = buildPartialManifestSchema();
	const property = schema.$defs.property;
	const sub = schema.$defs.repeaterProperty;

	assert.deepEqual(property.properties.type.enum, [...PROP_TYPES]);
	assert.deepEqual(sub.properties.type.enum, [...REPEATER_SUB_TYPES]);
	assert.ok(!sub.properties.type.enum.includes('repeater'));
	assert.equal(sub.properties.properties, undefined);
	assert.deepEqual(property.properties.when.items.items.properties.operator.enum, [...MANIFEST_WHEN_OPERATORS]);
	assert.deepEqual(
		Object.keys(property.properties.acf.properties),
		[...MANIFEST_ACF_PASSTHROUGH_KEYS],
	);
	assert.equal(schema.properties.$schema.const, PARTIAL_MANIFEST_SCHEMA_REF);
});

test('page template schema enums match the CLI validator', () => {
	const schema = buildPageTemplateManifestSchema();
	assert.equal(schema.properties.schemaVersion.const, TEMPLATE_MANIFEST_SCHEMA_VERSION);
	assert.equal(schema.properties.$schema.const, PAGE_TEMPLATE_MANIFEST_SCHEMA_REF);
	assert.deepEqual(schema.properties.editor.properties.lock.enum, [...TEMPLATE_LOCK_LEVELS]);
	assert.deepEqual(
		schema.properties.editor.properties.acf.properties.tabPlacement.enum,
		[...TEMPLATE_TAB_PLACEMENTS],
	);

	const branches = schema.properties.composition.items.oneOf;
	assert.deepEqual(branches.map((branch) => branch.title), ['Partial', 'Fields', 'Tab']);
	assert.deepEqual(Object.keys(branches[0].properties), ['id', 'label', 'partial']);
	assert.deepEqual(Object.keys(branches[1].properties), ['id', 'label', 'properties']);
	assert.deepEqual(Object.keys(branches[2].properties), ['id', 'label', 'items']);
	assert.equal(branches[2].properties.items.items.oneOf.length, 2);
});

test('default template manifest points at the page-template schema', () => {
	const data = buildDefaultTemplateManifest('template-home.php');
	assert.equal(Object.keys(data)[0], '$schema');
	assert.equal(data.$schema, PAGE_TEMPLATE_MANIFEST_SCHEMA_REF);
});

test('ensureManifestSchemas writes both files and skips an unchanged rewrite', () => {
	const dir = tmpTheme();
	try {
		const first = ensureManifestSchemas(dir);
		assert.equal(first.length, 2);
		const partial = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/schema/partial.schema.json'), 'utf8'));
		const page = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/schema/page-template.schema.json'), 'utf8'));
		assert.equal(partial.title, 'WonderPress partial manifest');
		assert.equal(page.title, 'WonderPress page template manifest');
		assert.deepEqual(ensureManifestSchemas(dir), []);
	} finally {
		fs.removeSync(dir);
	}
});

test('stampManifestSchemas adds $schema once and leaves other keys in order', () => {
	const dir = tmpTheme();
	try {
		const partials = path.join(dir, '.wonderpress/manifest/partials');
		const pages = path.join(dir, '.wonderpress/manifest/page-templates');
		fs.ensureDirSync(partials);
		fs.ensureDirSync(pages);
		fs.writeFileSync(path.join(partials, 'headline-stack.json'), `${JSON.stringify({
			name: 'Headline_Stack',
			slug: 'headline-stack',
			acf_compatible: true,
		}, null, 2)}\n`);
		fs.writeFileSync(path.join(pages, 'template-home.json'), `${JSON.stringify({
			schemaVersion: 1,
			template: 'template-home.php',
			composition: [{ id: 'hero', label: 'Hero', items: [{ id: 'hero-head', partial: 'headline-stack' }] }],
		}, null, 2)}\n`);

		const stamped = stampManifestSchemas(dir);
		assert.equal(stamped.length, 2);

		const partial = JSON.parse(fs.readFileSync(path.join(partials, 'headline-stack.json'), 'utf8'));
		assert.deepEqual(Object.keys(partial), ['$schema', 'name', 'slug', 'acf_compatible']);
		assert.equal(partial.$schema, PARTIAL_MANIFEST_SCHEMA_REF);

		const page = JSON.parse(fs.readFileSync(path.join(pages, 'template-home.json'), 'utf8'));
		assert.equal(page.$schema, PAGE_TEMPLATE_MANIFEST_SCHEMA_REF);
		assert.equal(page.composition[0].items[0].partial, 'headline-stack');

		const before = fs.readFileSync(path.join(pages, 'template-home.json'), 'utf8');
		assert.deepEqual(stampManifestSchemas(dir), []);
		assert.equal(fs.readFileSync(path.join(pages, 'template-home.json'), 'utf8'), before);
	} finally {
		fs.removeSync(dir);
	}
});

test('withManifestSchema replaces a stale $schema and keeps it first', () => {
	const next = withManifestSchema({ name: 'Hero', $schema: 'old.json', slug: 'hero' }, PARTIAL_MANIFEST_SCHEMA_REF);
	assert.deepEqual(Object.keys(next), ['$schema', 'name', 'slug']);
	assert.equal(next.$schema, PARTIAL_MANIFEST_SCHEMA_REF);
});

test('writeManifest records $schema and writes the schema files', () => {
	const dir = tmpTheme();
	try {
		writeManifest({
			class_name: 'Headline_Stack',
			is_acf_compatible: true,
			has_partial_template: true,
			partial_template_name: 'headline-stack.php',
			properties: [{ name: 'headline', type: 'string', required: true, description: '' }],
			emit: {},
		}, dir);
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/partials/headline-stack.json'), 'utf8'));
		assert.equal(manifest.$schema, PARTIAL_MANIFEST_SCHEMA_REF);
		assert.equal(Object.keys(manifest)[0], '$schema');
		assert.ok(fs.existsSync(path.join(dir, '.wonderpress/manifest/schema/partial.schema.json')));
		assert.ok(fs.existsSync(path.join(dir, '.wonderpress/manifest/schema/page-template.schema.json')));
	} finally {
		fs.removeSync(dir);
	}
});
