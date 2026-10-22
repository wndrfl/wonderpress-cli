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
	removeLegacySchemaDir,
	stampManifestSchemas,
	withManifestSchema,
} from '../src/manifest-schema.js';
import {
	MANIFEST_ACF_PASSTHROUGH_KEYS,
	MANIFEST_WHEN_OPERATORS,
	LEGACY_PAGE_TEMPLATE_MANIFEST_SCHEMA_REF,
	LEGACY_PARTIAL_MANIFEST_SCHEMA_REF,
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
	// The current ref first; the pre-2.23 ref stays valid until sync rewrites it.
	assert.deepEqual(schema.properties.$schema.enum, [PARTIAL_MANIFEST_SCHEMA_REF, LEGACY_PARTIAL_MANIFEST_SCHEMA_REF]);
});

test('page template schema enums match the CLI validator', () => {
	const schema = buildPageTemplateManifestSchema();
	assert.equal(schema.properties.schemaVersion.const, TEMPLATE_MANIFEST_SCHEMA_VERSION);
	assert.deepEqual(schema.properties.$schema.enum, [PAGE_TEMPLATE_MANIFEST_SCHEMA_REF, LEGACY_PAGE_TEMPLATE_MANIFEST_SCHEMA_REF]);
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

// Theme-relative with forward slashes on every OS, the way the tree is documented.
const posixRel = (dir, file) => path.relative(dir, file).split(path.sep).join('/');

test('ensureManifestSchemas writes both files and the README, and skips an unchanged rewrite', () => {
	const dir = tmpTheme();
	try {
		const first = ensureManifestSchemas(dir);
		assert.deepEqual(first.map((f) => posixRel(dir, f)), [
			'.wonderpress/schema/partial.schema.json',
			'.wonderpress/schema/page-template.schema.json',
			'.wonderpress/manifest/README.md',
		]);
		const partial = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/schema/partial.schema.json'), 'utf8'));
		const page = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/schema/page-template.schema.json'), 'utf8'));
		assert.equal(partial.title, 'Wonderpress partial manifest');
		assert.equal(page.title, 'Wonderpress page template manifest');
		assert.deepEqual(ensureManifestSchemas(dir), []);
	} finally {
		fs.removeSync(dir);
	}
});

test('ensureManifestSchemas removes the schema files a CLI up to 2.22.x left in the manifest tree', () => {
	const dir = tmpTheme();
	try {
		const legacy = path.join(dir, '.wonderpress/manifest/schema');
		fs.ensureDirSync(legacy);
		fs.writeFileSync(path.join(legacy, 'partial.schema.json'), '{}\n');
		fs.writeFileSync(path.join(legacy, 'page-template.schema.json'), '{}\n');

		ensureManifestSchemas(dir);
		assert.equal(fs.existsSync(legacy), false, 'the legacy directory is gone once empty');
		assert.ok(fs.existsSync(path.join(dir, '.wonderpress/schema/partial.schema.json')));
		assert.equal(removeLegacySchemaDir(dir), false, 'nothing left to remove');

		// A file of the person's own in there is not ours: the two schema
		// files go, the directory and that file stay.
		fs.ensureDirSync(legacy);
		fs.writeFileSync(path.join(legacy, 'partial.schema.json'), '{}\n');
		fs.writeFileSync(path.join(legacy, 'notes.md'), 'mine\n');
		ensureManifestSchemas(dir);
		assert.deepEqual(fs.readdirSync(legacy), ['notes.md']);
	} finally {
		fs.removeSync(dir);
	}
});

test('stampManifestSchemas rewrites the pre-2.23 $schema ref to the current one', () => {
	const dir = tmpTheme();
	try {
		const partials = path.join(dir, '.wonderpress/manifest/partials');
		const pages = path.join(dir, '.wonderpress/manifest/page-templates');
		fs.ensureDirSync(partials);
		fs.ensureDirSync(pages);
		fs.writeFileSync(path.join(partials, 'hero.json'), `${JSON.stringify({ $schema: LEGACY_PARTIAL_MANIFEST_SCHEMA_REF, name: 'Hero', slug: 'hero' }, null, 2)}\n`);
		fs.writeFileSync(path.join(pages, 'template-home.json'), `${JSON.stringify({ $schema: LEGACY_PAGE_TEMPLATE_MANIFEST_SCHEMA_REF, schemaVersion: 1, template: 'template-home.php', composition: [] }, null, 2)}\n`);

		assert.deepEqual(stampManifestSchemas(dir).map((f) => path.basename(f)).sort(), ['hero.json', 'template-home.json']);
		const hero = JSON.parse(fs.readFileSync(path.join(partials, 'hero.json'), 'utf8'));
		assert.equal(hero.$schema, PARTIAL_MANIFEST_SCHEMA_REF);
		assert.deepEqual(Object.keys(hero), ['$schema', 'name', 'slug'], 'only the ref changed, and it stays first');
		assert.equal(JSON.parse(fs.readFileSync(path.join(pages, 'template-home.json'), 'utf8')).$schema, PAGE_TEMPLATE_MANIFEST_SCHEMA_REF);
		assert.deepEqual(stampManifestSchemas(dir), []);
	} finally {
		fs.removeSync(dir);
	}
});

test('the manifest README says who writes what, and the CLI keeps it current', () => {
	const dir = tmpTheme();
	try {
		ensureManifestSchemas(dir);
		const file = path.join(dir, '.wonderpress/manifest/README.md');
		const body = fs.readFileSync(file, 'utf8');
		// One row per kind of file under .wonderpress/, each saying whose it is.
		for (const row of ['manifest/partials/<slug>.json', 'manifest/page-templates/<name>.json', 'schema/*.schema.json', 'locks/<slug>.json']) {
			assert.match(body, new RegExp(`^\\| \`${row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``, 'm'), `a row for ${row}`);
		}
		assert.match(body, /\| Edit it\? \| Commit it\? \|/);
		assert.match(body, /written by the Wonderpress CLI/);

		// Hand edits do not survive: the README is the CLI's.
		fs.writeFileSync(file, '# mine\n');
		assert.deepEqual(ensureManifestSchemas(dir).map((f) => posixRel(dir, f)), ['.wonderpress/manifest/README.md']);
		assert.equal(fs.readFileSync(file, 'utf8'), body);
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
		assert.ok(fs.existsSync(path.join(dir, '.wonderpress/schema/partial.schema.json')));
		assert.ok(fs.existsSync(path.join(dir, '.wonderpress/schema/page-template.schema.json')));
	} finally {
		fs.removeSync(dir);
	}
});
