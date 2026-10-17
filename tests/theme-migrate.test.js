import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
	mapLegacyFormat,
	migrateProperty,
	parseLegacyClass,
	parsePhpValue,
	parseTypeOverrides,
	planMigration,
	renderMigratedClass,
	toPlainObject,
} from '../src/legacy-partial.js';
import { checkPartialDrift } from '../src/partial-drift.js';
import { extractFencedRegion, renderFencedRegion } from '../src/partial-class.js';
import { paramsFromManifest } from '../src/partial.js';

/**
 * `theme migrate`: one class-based legacy partial at a time, under a manifest.
 * What is pinned here is the contract the desktop app reads (the inventory,
 * the dry-run report, the apply envelope), that a dry run writes nothing, that
 * apply preserves what it must (custom members, the view, the original class),
 * and that the result is a partial `partial sync` / check-drift already know.
 *
 * The fixture theme under tests/fixtures/legacy-theme is copied from the
 * shapes in the wonderful-www theme: an empty-properties class, a class with
 * string/object/array/string|array formats and a custom method, one that
 * extends a core class, one with boolean formats, one already migrated (the
 * test writes its manifest), and one ACF block.
 **/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'legacy-theme');

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-theme-migrate-')));
}

/** A project with the fixture theme copied in, adopted unless told otherwise. */
function project({ adopt = true, migratedRibbon = true } = {}) {
	const root = tmp();
	fs.writeFileSync(path.join(root, '.wonderpressrc'), '{}\n');
	const theme = path.join(root, 'wp-content/themes/wonderpress');
	fs.copySync(FIXTURE, theme);
	fs.writeFileSync(path.join(theme, 'style.css'), '/* Theme Name: wonderpress */\n');
	if (adopt) {
		const result = cli(['theme', 'adopt', '--format', 'json'], root);
		assert.equal(result.status, 0, result.stderr);
	}
	if (adopt && migratedRibbon) {
		// Stamped with $schema already, as every manifest writer leaves them,
		// so an apply of another partial has no reason to touch this file.
		fs.writeJsonSync(path.join(theme, '.wonderpress/manifest/partials/ribbon.json'), {
			$schema: '../schema/partial.schema.json',
			name: 'Ribbon',
			slug: 'ribbon',
			acf_compatible: false,
			properties: [{ name: 'text', type: 'string', required: true, description: 'Ribbon text' }],
			artifacts: { class: 'src/partials/class-ribbon.php', view: 'partials/ribbon.php' },
		}, { spaces: 2 });
	}
	return { root, theme };
}

function cli(argv, cwd) {
	return spawnSync('node', [BIN, ...argv], { encoding: 'utf8', cwd, env: { ...process.env, WONDERPRESS_ENV: '' } });
}

/** stdout must be exactly one envelope line — the app's whole contract. */
function onlyEnvelope(stdout) {
	const lines = String(stdout).split('\n').filter((l) => l.trim());
	assert.equal(lines.length, 1, `expected exactly one stdout line, got:\n${stdout}`);
	return JSON.parse(lines[0]);
}

/** Every path under a directory with its bytes, so "touched nothing" is checkable. */
function snapshot(dir) {
	const out = new Map();
	const walk = (d) => {
		for (const entry of fs.readdirSync(d).sort()) {
			const abs = path.join(d, entry);
			const rel = path.relative(dir, abs).split(path.sep).join('/');
			if (fs.statSync(abs).isDirectory()) {
				out.set(rel, null);
				walk(abs);
			} else {
				out.set(rel, fs.readFileSync(abs, 'utf8'));
			}
		}
	};
	walk(dir);
	return out;
}

function migrateJson(root, argv) {
	const result = cli(['theme', 'migrate', ...argv, '--format', 'json'], root);
	return { result, envelope: onlyEnvelope(result.stdout) };
}

const byName = (list) => Object.fromEntries(list.map((p) => [p.name, p]));

// --- the inventory ---

test('migrate needs the manifest tree and points at theme adopt without it', () => {
	const { root, theme } = project({ adopt: false });
	const before = snapshot(theme);
	const { result, envelope } = migrateJson(root, ['--list']);
	assert.equal(result.status, 1);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, 'not_adopted');
	assert.match(envelope.error.hint, /wonderpress theme adopt/);
	assert.deepEqual(snapshot(theme), before, 'a refused migrate touches nothing');
});

test('--list inventories classes with a status each and lists ACF blocks as out of scope', () => {
	const { root, theme } = project();
	const before = snapshot(theme);
	const { result, envelope } = migrateJson(root, ['--list']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(envelope.ok, true);
	assert.equal(envelope.error, null);
	assert.equal(envelope.data.theme, 'wonderpress');

	const partials = Object.fromEntries(envelope.data.partials.map((p) => [p.slug, p]));

	assert.deepEqual(partials['theme-blog-category-nav'], {
		kind: 'class',
		classPath: 'src/partials/class-theme-blog-category-nav.php',
		slug: 'theme-blog-category-nav',
		className: 'Theme_Blog_Category_Nav',
		viewPath: 'partials/theme-blog-category-nav.php',
		properties: 0,
		status: 'ready',
	}, 'an empty $_properties array is ready');

	assert.equal(partials['theme-text-stack'].status, 'ready', 'all-string formats need no decision');
	assert.equal(partials['theme-text-stack'].properties, 3);
	assert.equal(partials.image.status, 'ready', 'a class with no $_properties at all is ready');
	assert.equal(partials.image.viewPath, 'partials/image.php', 'a view path without ./ resolves the same');

	assert.equal(partials['theme-article-grid-item'].status, 'review', 'object/array/string|array formats need a decision');
	assert.equal(partials['theme-article-grid-item'].properties, 4);
	assert.equal(partials['theme-article-grid-item'].viewPath, null, 'a class without $_partial_template has no view');
	assert.equal(partials['theme-project-grid-item'].status, 'review');
	assert.equal(partials.toggle.status, 'ready', 'boolean and bool both map');

	assert.equal(partials.ribbon.status, 'migrated', 'a manifest on disk means migrated');

	assert.deepEqual(partials['block-quote'], {
		kind: 'acf-block',
		slug: 'block-quote',
		path: 'partials/blocks/block-quote.php',
		status: 'not migrated',
	});

	assert.deepEqual(snapshot(theme), before, 'listing writes nothing');
});

// --- the dry run ---

test('a dry run reports the manifest and the review notes and writes nothing', () => {
	const { root, theme } = project();
	const before = snapshot(theme);
	const { result, envelope } = migrateJson(root, ['theme-project-grid-item']);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(envelope.ok, true);

	const data = envelope.data;
	assert.equal(data.slug, 'theme-project-grid-item');
	assert.equal(data.manifestPath, path.join(theme, '.wonderpress/manifest/partials/theme-project-grid-item.json'));
	assert.equal(data.applied, false);
	assert.equal(data.review, true);
	assert.deepEqual(data.files, { written: [], preserved: [] });

	const props = byName(data.properties);
	assert.equal(props.project_obj.type, 'post_object');
	assert.equal(props.project_obj.source, 'format:object');
	assert.equal(props.project_obj.review, true);
	assert.match(props.project_obj.note, /--type project_obj=<type>/);
	assert.equal(props.image_size.type, 'string');
	assert.equal(props.image_size.source, 'format:string');
	assert.equal(props.image_size.review, false);
	assert.match(props.image_size.note, /default "large" dropped/);

	assert.deepEqual(data.manifest, {
		name: 'Theme_Project_Grid_Item',
		slug: 'theme-project-grid-item',
		acf_compatible: false,
		properties: [
			{ name: 'project_obj', type: 'post_object', required: true, description: 'The project object to display' },
			{ name: 'image_size', type: 'string', required: true, description: 'The image size to display' },
		],
		artifacts: {
			class: 'src/partials/class-theme-project-grid-item.php',
			view: 'partials/theme-project-grid-item.php',
		},
	});
	assert.equal('block' in data.manifest, false, 'a migrated partial is never a block');

	assert.deepEqual(snapshot(theme), before, 'a dry run touches nothing');
});

test('every legacy format maps as documented, and --type overrides one', () => {
	const { root } = project();
	const plain = migrateJson(root, ['theme-article-grid-item']).envelope.data;
	const props = byName(plain.properties);
	assert.deepEqual(
		Object.fromEntries(Object.values(props).map((p) => [p.name, [p.type, p.source, p.review]])),
		{
			post_obj: ['post_object', 'format:object', true],
			attributes: ['string', 'format:array', true],
			classes: ['string', 'format:string|array', true],
			type: ['string', 'format:string', false],
		},
	);
	assert.match(props.attributes.note, /legacy format 'array' has no single manifest type/);
	assert.equal(plain.review, true);
	assert.ok(plain.notes.some((n) => /no \$_partial_template/.test(n)), 'a class without a view says so');
	assert.ok(plain.notes.some((n) => /custom members found/.test(n)), 'the render method is noticed');

	const overridden = migrateJson(root, [
		'theme-article-grid-item',
		'--type', 'post_obj=post_object',
		'--type', 'attributes=string',
		'--type', 'classes=string',
	]).envelope.data;
	assert.equal(overridden.review, false, 'every flagged property has a decision');
	const over = byName(overridden.properties);
	assert.deepEqual([over.post_obj.source, over.attributes.source, over.classes.source], ['override', 'override', 'override']);
	assert.equal(over.type.source, 'format:string', 'an unflagged property keeps its mapping');
	assert.match(over.attributes.note, /type set to string by --type/);
});

test('required is dropped with a note on types that cannot be required', () => {
	const { root } = project();
	const data = migrateJson(root, ['toggle']).envelope.data;
	assert.equal(data.review, false);
	const props = byName(data.properties);
	assert.equal(props.visible.type, 'boolean');
	assert.match(props.visible.note, /required dropped: a boolean property cannot be required/);
	assert.equal(props.compact.type, 'boolean', "'bool' maps too");
	assert.equal(props.compact.note, null);
	const manifestProps = byName(data.manifest.properties);
	assert.equal(manifestProps.visible.required, false);
	assert.equal(manifestProps.visible.description, "Whether it's shown", 'double-quoted PHP strings read back');
	assert.deepEqual(data.manifest.artifacts, { class: 'src/partials/class-toggle.php', view: 'partials/toggle.php' });

	// Overriding onto a forbidden type drops required the same way.
	const asLink = byName(migrateJson(root, ['toggle', '--type', 'label=link']).envelope.data.properties);
	assert.equal(asLink.label.type, 'link');
	assert.equal(asLink.label.note.includes('required dropped'), false, 'it was not required to begin with');
});

test('a bad --type is a usage error before anything is read as a plan', () => {
	const { root } = project();
	const badType = migrateJson(root, ['toggle', '--type', 'label=widget']);
	assert.equal(badType.result.status, 2);
	assert.equal(badType.envelope.error.code, 'usage');
	assert.match(badType.envelope.error.message, /Invalid type "widget"/);

	const unknownName = migrateJson(root, ['toggle', '--type', 'nope=string']);
	assert.equal(unknownName.result.status, 2);
	assert.match(unknownName.envelope.error.message, /does not declare/);

	const malformed = migrateJson(root, ['toggle', '--type', 'label']);
	assert.equal(malformed.result.status, 2);
	assert.match(malformed.envelope.error.message, /expected name=type/);

	// A type that needs more than a name (select needs choices) fails the
	// same validation sync applies, instead of writing an invalid manifest.
	const select = migrateJson(root, ['toggle', '--type', 'label=select']);
	assert.equal(select.envelope.ok, false);
	assert.equal(select.envelope.error.code, 'invalid');
});

test('an unknown slug and a missing slug are errors in the envelope', () => {
	const { root } = project();
	const missing = migrateJson(root, []);
	assert.equal(missing.result.status, 2);
	assert.equal(missing.envelope.error.code, 'usage');

	const unknown = migrateJson(root, ['nope']);
	assert.equal(unknown.result.status, 1);
	assert.equal(unknown.envelope.error.code, 'not_found');
	assert.match(unknown.envelope.error.hint, /theme-text-stack/);

	// A class name works as well as a slug.
	assert.equal(migrateJson(root, ['Theme_Text_Stack']).envelope.data.slug, 'theme-text-stack');
});

// --- apply ---

test('--apply refuses a partial that still needs review and writes nothing', () => {
	const { root, theme } = project();
	const before = snapshot(theme);
	const { result, envelope } = migrateJson(root, ['theme-project-grid-item', '--apply']);
	assert.equal(result.status, 1);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, 'review');
	assert.match(envelope.error.hint, /--type project_obj=<type>/);
	assert.equal(envelope.data.applied, false, 'the plan rides along so the app can show what to decide');
	assert.equal(envelope.data.review, true);
	assert.deepEqual(snapshot(theme), before, 'a refused apply touches nothing');
});

test('--apply writes the manifest, fences the class, keeps the rest, and is idempotent', () => {
	const { root, theme } = project();
	const classRel = 'src/partials/class-theme-article-grid-item.php';
	const original = fs.readFileSync(path.join(theme, classRel), 'utf8');
	const before = snapshot(theme);

	const { result, envelope } = migrateJson(root, [
		'theme-article-grid-item', '--apply',
		'--type', 'post_obj=post_object', '--type', 'attributes=string', '--type', 'classes=string',
	]);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(envelope.ok, true);
	const data = envelope.data;
	assert.equal(data.applied, true);
	assert.equal(data.drift, 'clean');
	assert.deepEqual(data.files, {
		written: [
			classRel,
			'.wonderpress/manifest/partials/theme-article-grid-item.json',
			'.wonderpress/manifest/partials/theme-article-grid-item.lock.json',
		],
		preserved: [`${classRel}.legacy`],
	});

	// The manifest is what partial create would have recorded.
	const manifest = fs.readJsonSync(path.join(theme, '.wonderpress/manifest/partials/theme-article-grid-item.json'));
	assert.equal(manifest.name, 'Theme_Article_Grid_Item');
	assert.equal(manifest.acf_compatible, false);
	assert.equal('block' in manifest, false);
	assert.deepEqual(manifest.artifacts, { class: classRel }, 'no view, no style: nothing invented');
	assert.deepEqual(manifest.properties.map((p) => [p.name, p.type, p.required]), [
		['post_obj', 'post_object', true],
		['attributes', 'string', false],
		['classes', 'string', false],
		['type', 'string', false],
	]);
	assert.deepEqual(data.manifest, manifest);

	// The class: the fence sync maintains, the old property block gone, the
	// custom method kept below the closing marker, the original beside it.
	const source = fs.readFileSync(path.join(theme, classRel), 'utf8');
	const region = extractFencedRegion(source);
	assert.ok(region, 'the class is fenced');
	assert.equal(region, renderFencedRegion(paramsFromManifest(manifest)), 'the region is exactly what sync writes');
	assert.equal(source.includes('$_properties'), false, 'the legacy property block is replaced');
	assert.ok(source.includes('public function render_into_template()'), 'custom members survive');
	assert.ok(source.indexOf('render_into_template') > source.indexOf('</wonderpress:generated>'), 'below the closing marker');
	assert.equal(fs.readFileSync(path.join(theme, `${classRel}.legacy`), 'utf8'), original, 'the original is kept byte for byte');

	// Drift is clean through the real checker, and sync sees nothing to do.
	assert.equal(checkPartialDrift(manifest, theme).state, 'clean');
	const drift = onlyEnvelope(cli(['partial', 'check-drift', 'Theme_Article_Grid_Item', '--theme', 'wonderpress', '--format', 'json'], root).stdout);
	assert.equal(drift.ok, true);
	assert.equal(drift.data.partials[0].state, 'clean');

	// Everything else in the theme is untouched.
	const after = snapshot(theme);
	const touched = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
	assert.deepEqual(touched.sort(), [
		'.wonderpress/manifest/partials/theme-article-grid-item.json',
		'.wonderpress/manifest/partials/theme-article-grid-item.lock.json',
		'.wonderpress/manifest/schema',
		'.wonderpress/manifest/schema/page-template.schema.json',
		'.wonderpress/manifest/schema/partial.schema.json',
		classRel,
		`${classRel}.legacy`,
	], 'only the partial\'s own files (and the manifest schemas every writer stamps) change');

	// Idempotent: a second apply is a no-op that says so.
	const again = migrateJson(root, ['theme-article-grid-item', '--apply', '--type', 'post_obj=post_object', '--type', 'attributes=string', '--type', 'classes=string']);
	assert.equal(again.result.status, 0, again.result.stderr);
	assert.equal(again.envelope.data.applied, false);
	assert.deepEqual(again.envelope.data.files, { written: [], preserved: [] });
	assert.match(again.envelope.data.notes[0], /already exists/);
	assert.deepEqual(snapshot(theme), after, 'the second apply changes nothing');
	assert.equal(again.envelope.data.manifestPath, data.manifestPath);

	// The inventory now says so too.
	const listed = migrateJson(root, ['--list']).envelope.data.partials.find((p) => p.slug === 'theme-article-grid-item');
	assert.equal(listed.status, 'migrated');
});

test('--apply leaves the view untouched and records it, and keeps a core parent class', () => {
	const { root, theme } = project();
	const viewRel = 'partials/theme-project-grid-item.php';
	const viewBefore = fs.readFileSync(path.join(theme, viewRel), 'utf8');

	const applied = migrateJson(root, ['theme-project-grid-item', '--apply', '--type', 'project_obj=post_object']).envelope.data;
	assert.equal(applied.applied, true);
	assert.deepEqual(applied.files.preserved, ['src/partials/class-theme-project-grid-item.php.legacy', viewRel]);
	assert.equal(fs.readFileSync(path.join(theme, viewRel), 'utf8'), viewBefore, 'the view is never rewritten');
	assert.deepEqual(applied.manifest.artifacts, {
		class: 'src/partials/class-theme-project-grid-item.php',
		view: viewRel,
	}, 'no static tree, so no style stub is invented');
	const source = fs.readFileSync(path.join(theme, 'src/partials/class-theme-project-grid-item.php'), 'utf8');
	assert.ok(source.includes("protected $partial_template = './partials/theme-project-grid-item.php';"));
	assert.equal(checkPartialDrift(applied.manifest, theme).state, 'clean');

	// A class that extends a core partial keeps that parent and its import.
	const image = migrateJson(root, ['image', '--apply']).envelope.data;
	assert.equal(image.applied, true);
	assert.ok(image.notes.some((n) => /extends Core_Image/.test(n)));
	const imageSource = fs.readFileSync(path.join(theme, 'src/partials/class-image.php'), 'utf8');
	assert.ok(imageSource.includes('class Image extends Core_Image {'));
	assert.ok(imageSource.includes('use Wonderpress_Core\\Partials\\Image as Core_Image;'));
	assert.equal(checkPartialDrift(image.manifest, theme).state, 'clean');

	// A ready partial with the legacy ACF flag: migrated, with the flag noted.
	const stack = migrateJson(root, ['theme-text-stack', '--apply']).envelope.data;
	assert.equal(stack.applied, true);
	assert.equal(stack.manifest.acf_compatible, false);
	assert.ok(stack.notes.some((n) => /\$_acf_compatible = true/.test(n)));
});

test('human output prints the manifest and the review notes', () => {
	const { root } = project();
	const dry = cli(['theme', 'migrate', 'theme-project-grid-item'], root);
	assert.equal(dry.status, 0, dry.stderr);
	assert.match(dry.stdout, /Manifest that would be written/);
	assert.match(dry.stdout, /"name": "Theme_Project_Grid_Item"/);
	assert.match(dry.stdout, /project_obj: post_object \(format:object\)/);
	assert.match(dry.stdout, /Needs review before --apply/);

	const list = cli(['theme', 'migrate', '--list'], root);
	assert.match(list.stdout, /theme-text-stack {2}ready/);
	assert.match(list.stdout, /ribbon {2}migrated/);
	assert.match(list.stdout, /block-quote {2}not migrated/);

	const refused = cli(['theme', 'migrate', 'theme-project-grid-item', '--apply'], root);
	assert.equal(refused.status, 1);
	assert.match(refused.stdout + refused.stderr, /Refusing to apply/);

	const applied = cli(['theme', 'migrate', 'toggle', '--apply'], root);
	assert.equal(applied.status, 0, applied.stderr);
	assert.match(applied.stdout, /Migrated toggle/);
	assert.match(applied.stdout, /class-toggle\.php\.legacy/);
	assert.match(applied.stdout, /check-drift: clean/);

	assert.match(cli(['theme'], root).stdout, /theme migrate/);
});

// --- the pure pieces ---

test('parsePhpValue reads both array syntaxes, strings, scalars, comments and raw values', () => {
	const src = `array(
		// a comment
		'a' => "tab\\there", # another
		'b' => [ 1, 2.5, -3 ],
		'c' => TRUE, 'd' => null,
		'e' => 'it\\'s',
		'f' => __( 'Hello, world', 'domain' ),
		'g' => array( 'nested' => false, ),
	)`;
	const { value, end } = parsePhpValue(src);
	assert.equal(end, src.length);
	assert.deepEqual(toPlainObject(value), {
		a: 'tab\there',
		b: [1, 2.5, -3],
		c: true,
		d: null,
		e: "it's",
		f: { raw: "__( 'Hello, world', 'domain' )" },
		g: { nested: false },
	});
	assert.throws(() => parsePhpValue("array( 'a' => 'open"), /Unterminated string/);
	assert.throws(() => parsePhpValue("array( 'a' => 1"), /Unterminated array/);
});

test('parseLegacyClass separates the generated members from the custom body', () => {
	const source = fs.readFileSync(path.join(FIXTURE, 'src/partials/class-theme-article-grid-item.php'), 'utf8');
	const legacy = parseLegacyClass(source);
	assert.equal(legacy.className, 'Theme_Article_Grid_Item');
	assert.equal(legacy.parent, 'Abstract_Partial');
	assert.equal(legacy.viewPath, null);
	assert.equal(legacy.acfCompatible, false);
	assert.deepEqual(legacy.properties.map((p) => [p.name, p.spec.format, p.spec.required]), [
		['post_obj', 'object', true],
		['attributes', 'array', false],
		['classes', 'string|array', false],
		['type', 'string', false],
	]);
	assert.ok(legacy.customBody.startsWith('\t/**'), 'the docblock of the custom method is kept');
	assert.ok(legacy.customBody.includes('public function render_into_template()'));
	assert.equal(legacy.customBody.includes('$_properties'), false);

	const empty = parseLegacyClass(fs.readFileSync(path.join(FIXTURE, 'src/partials/class-theme-blog-category-nav.php'), 'utf8'));
	assert.deepEqual(empty.properties, []);
	assert.equal(empty.viewPath, 'partials/theme-blog-category-nav.php');
	assert.equal(empty.customBody, '', 'nothing but generated members leaves an empty custom body');

	const flagged = parseLegacyClass(fs.readFileSync(path.join(FIXTURE, 'src/partials/class-theme-text-stack.php'), 'utf8'));
	assert.equal(flagged.acfCompatible, true);

	assert.throws(() => parseLegacyClass('<?php\n// nothing here\n'), /No class declaration/);
});

test('mapLegacyFormat and migrateProperty follow the documented table', () => {
	assert.deepEqual(mapLegacyFormat('string'), { type: 'string', review: false, reason: null });
	assert.deepEqual(mapLegacyFormat('boolean').type, 'boolean');
	assert.deepEqual(mapLegacyFormat('bool').type, 'boolean');
	assert.equal(mapLegacyFormat('object').type, 'post_object');
	assert.equal(mapLegacyFormat('object').review, true);
	for (const format of ['array', 'string|array', 'integer', 'whatever', null]) {
		const mapped = mapLegacyFormat(format);
		assert.equal(mapped.type, 'string', `${format} defaults to string`);
		assert.equal(mapped.review, true, `${format} is flagged`);
	}

	const { property, report } = migrateProperty({ name: 'on', spec: { format: 'boolean', required: true, description: 'x' } });
	assert.deepEqual(property, { name: 'on', type: 'boolean', required: false, description: 'x' });
	assert.match(report.note, /required dropped/);

	const raw = migrateProperty({ name: 'label', spec: { format: 'string', description: { raw: "__( 'x' )" } } });
	assert.equal(raw.property.description, '');
	assert.match(raw.report.note, /description was not a plain string/);

	assert.deepEqual(parseTypeOverrides(['a=string', 'b=image'], ['a', 'b']), { a: 'string', b: 'image' });
	assert.throws(() => parseTypeOverrides(['a=nope'], ['a']), /Invalid type/);
});

test('planMigration blocks a view outside partials/ with a note --type cannot clear', () => {
	const legacy = parseLegacyClass(`<?php
namespace Wonderpress\\Partials;
class Deep extends Abstract_Partial {
	protected $_partial_template = './partials/deep/view.php';
	protected static $_properties = array();
}
`);
	const plan = planMigration(legacy);
	assert.equal(plan.review, true);
	assert.equal(plan.blockers.length, 1);
	assert.match(plan.blockers[0], /not directly under partials\//);
	assert.equal(plan.params.has_partial_template, false);

	// The regenerated class carries the fence sync maintains, and nothing else of the old members.
	const rendered = renderMigratedClass(plan.params, legacy);
	assert.equal(extractFencedRegion(rendered), renderFencedRegion(plan.params));
	assert.equal(rendered.includes('$_partial_template'), false);
});
