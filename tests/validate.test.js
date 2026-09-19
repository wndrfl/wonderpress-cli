import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isValidClassName,
	isValidTemplateName,
	isValidPropType,
	parsePropFlag,
	parseSubFlag,
	parseSectionFlag,
	buildDefaultTemplateManifest,
	flattenTemplateComposition,
	validateTemplateManifest,
	validateTemplateComposition,
	compositionRowIsTab,
	compositionRowIsFieldGroup,
	phpFormatForType,
	normalizeProperty,
	classNameToFileSlug,
	defaultTemplateName,
	isSafeSlug,
	resolveWithin,
	PROP_TYPES,
	TEMPLATE_MANIFEST_SCHEMA_VERSION,
} from '../src/validate.js';

test('isValidClassName accepts WordPress snake-case, rejects the rest', () => {
	assert.ok(isValidClassName('Testimonial'));
	assert.ok(isValidClassName('Example_Class'));
	assert.ok(isValidClassName('My_Cool_Thing'));
	assert.ok(!isValidClassName('bad-name'));
	assert.ok(!isValidClassName('lowercase'));
	assert.ok(!isValidClassName('Has Space'));
	assert.ok(!isValidClassName(''));
});

test('isValidTemplateName', () => {
	assert.ok(isValidTemplateName('my-template.php'));
	assert.ok(isValidTemplateName('testimonial.php'));
	assert.ok(!isValidTemplateName('Bad_Name.php'));
	assert.ok(!isValidTemplateName('no-extension'));
});

test('isValidPropType matches the shipped type set', () => {
	for (const t of PROP_TYPES) {
		assert.ok(isValidPropType(t));
	}
	assert.ok(isValidPropType('image'));
	assert.ok(isValidPropType('link'));
	assert.ok(isValidPropType('repeater'));
	assert.ok(!isValidPropType('nope'));
});

test('parsePropFlag parses name:type[:required]', () => {
	assert.deepEqual(parsePropFlag('quote:string:required'), { name: 'quote', type: 'string', required: true, description: '' });
	assert.deepEqual(parsePropFlag('company:string'), { name: 'company', type: 'string', required: false, description: '' });
});

test('parsePropFlag throws on malformed input', () => {
	assert.throws(() => parsePropFlag('justname'), /Expected format/);
	assert.throws(() => parsePropFlag('x:badtype'), /Invalid property type/);
});

test('parseSubFlag parses parent:name:type[:required]', () => {
	assert.deepEqual(parseSubFlag('items:quote:string:required'), {
		parent: 'items', name: 'quote', type: 'string', required: true, description: '',
	});
	assert.deepEqual(parseSubFlag('items:photo:image'), {
		parent: 'items', name: 'photo', type: 'image', required: false, description: '',
	});
});

test('parseSubFlag refuses nested-repeater types and malformed input', () => {
	assert.throws(() => parseSubFlag('items:onlytwo'), /Expected format/);
	assert.throws(() => parseSubFlag('items:rows:repeater'), /Invalid repeater sub-field type/);
	assert.throws(() => parseSubFlag('items:meta:object'), /Invalid repeater sub-field type/);
});

test('phpFormatForType maps media and repeaters to array', () => {
	assert.equal(phpFormatForType('string'), 'string');
	assert.equal(phpFormatForType('boolean'), 'boolean');
	assert.equal(phpFormatForType('image'), 'array');
	assert.equal(phpFormatForType('link'), 'array');
	assert.equal(phpFormatForType('repeater'), 'array');
});

test('normalizeProperty keeps nested repeater rows', () => {
	assert.deepEqual(
		normalizeProperty({
			name: 'items', type: 'repeater', required: true,
			properties: [{ name: 'quote', type: 'string', required: true }],
		}),
		{
			name: 'items', type: 'repeater', required: true, description: '',
			properties: [{ name: 'quote', type: 'string', required: true, description: '' }],
		}
	);
});

test('classNameToFileSlug converts EVERY underscore (regression)', () => {
	assert.equal(classNameToFileSlug('My_Cool_Thing'), 'class-my-cool-thing');
	assert.equal(classNameToFileSlug('Testimonial'), 'class-testimonial');
});

test('defaultTemplateName', () => {
	assert.equal(defaultTemplateName('My_Cool_Thing'), 'my-cool-thing.php');
	assert.equal(defaultTemplateName('Testimonial'), 'testimonial.php');
});

test('isSafeSlug accepts only what a path may be built from', () => {
	for (const slug of ['hero', 'call-to-action', 'grid-2up']) {
		assert.ok(isSafeSlug(slug), slug);
	}
	for (const slug of ['', '../foo', 'a/b', '.', 'Hero', 'hero.json', 'hero_x', null, undefined]) {
		assert.ok(!isSafeSlug(slug), String(slug));
	}
});

test('buildDefaultTemplateManifest includes schemaVersion and template filename', () => {
	const data = buildDefaultTemplateManifest('template-landing.php', {
		lock: 'all',
		sections: [{ id: 'hero-main', partial: 'landing-hero' }],
	});
	assert.equal(data.schemaVersion, TEMPLATE_MANIFEST_SCHEMA_VERSION);
	assert.equal(data.template, 'template-landing.php');
	assert.equal(data.composition.length, 1);
	assert.equal(data.editor.native.blockEditor, false);
});

test('validateTemplateManifest rejects bad schemaVersion and unknown partials', () => {
	const good = validateTemplateManifest(
		buildDefaultTemplateManifest('template-landing.php', {
			sections: [{ id: 'hero-main', partial: 'landing-hero' }],
		}),
		{ partialSlugs: ['landing-hero'] }
	);
	assert.equal(good.ok, true);

	const badVersion = validateTemplateManifest({ schemaVersion: 99, template: 'x.php' }, {});
	assert.equal(badVersion.ok, false);

	const dup = validateTemplateManifest(
		{
			schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
			template: 'template-landing.php',
			composition: [
				{ id: 'a', partial: 'landing-hero' },
				{ id: 'a', partial: 'landing-hero' },
			],
		},
		{ partialSlugs: ['landing-hero'] }
	);
	assert.equal(dup.ok, false);
});

test('flattenTemplateComposition flattens tab items in order', () => {
	const composition = [
		{ id: 'seo', partial: 'page-meta' },
		{
			id: 'hero',
			label: 'Hero',
			items: [
				{ id: 'hero-main', partial: 'landing-hero' },
				{ id: 'hero-cta', partial: 'cta-strip' },
			],
		},
		{ id: 'footer-cta', partial: 'cta-strip' },
	];
	assert.equal(flattenTemplateComposition(composition).length, 4);
	assert.deepEqual(
		flattenTemplateComposition(composition).map((r) => r.id),
		['seo', 'hero-main', 'hero-cta', 'footer-cta'],
	);
	assert.equal(compositionRowIsTab(composition[1]), true);
	assert.equal(compositionRowIsTab(composition[0]), false);
});

test('validateTemplateComposition accepts tabs and rejects nested tabs', () => {
	const ok = validateTemplateComposition(
		[
			{ id: 'a', partial: 'landing-hero' },
			{
				id: 'hero',
				items: [{ id: 'hero-main', partial: 'landing-hero' }],
			},
		],
		{ partialSlugs: ['landing-hero'] },
	);
	assert.equal(ok.length, 0);

	const nested = validateTemplateComposition(
		[
			{
				id: 'outer',
				items: [
					{
						id: 'inner-tab',
						items: [{ id: 'x', partial: 'landing-hero' }],
					},
				],
			},
		],
		{ partialSlugs: ['landing-hero'] },
	);
	assert.ok(nested.some((e) => /cannot nest another tab/.test(e)));

	const dup = validateTemplateComposition(
		[
			{ id: 'same', partial: 'landing-hero' },
			{
				id: 'hero',
				items: [{ id: 'same', partial: 'landing-hero' }],
			},
		],
		{ partialSlugs: ['landing-hero'] },
	);
	assert.ok(dup.some((e) => /Duplicate composition id "same"/.test(e)));
});

test('validateTemplateManifest accepts editor.acf.tabPlacement', () => {
	const left = validateTemplateManifest(
		{
			schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
			template: 'template-landing.php',
			editor: { acf: { tabPlacement: 'left' } },
			composition: [{ id: 'hero', items: [{ id: 'a', partial: 'landing-hero' }] }],
		},
		{ partialSlugs: ['landing-hero'] },
	);
	assert.equal(left.ok, true);

	const bad = validateTemplateManifest(
		{
			schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
			template: 'template-landing.php',
			editor: { acf: { tabPlacement: 'side' } },
		},
		{},
	);
	assert.equal(bad.ok, false);
	assert.ok(bad.errors.some((e) => /tabPlacement/.test(e)));
});

test('compositionRowIsFieldGroup detects inline properties rows', () => {
	assert.equal(compositionRowIsFieldGroup({ id: 'x', properties: [{ name: 'a', type: 'string' }] }), true);
	assert.equal(compositionRowIsFieldGroup({ id: 'x', partial: 'hero' }), false);
	assert.equal(compositionRowIsFieldGroup({ id: 'x', properties: [] }), false);
});

test('validateTemplateManifest accepts inline properties composition rows', () => {
	const result = validateTemplateManifest(
		{
			schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
			template: 'template-landing.php',
			composition: [
				{
					id: 'page-meta',
					properties: [
						{ name: 'meta_title', type: 'string', required: true },
						{ name: 'no_index', type: 'boolean' },
					],
				},
				{ id: 'hero-main', partial: 'landing-hero' },
			],
		},
		{ partialSlugs: ['landing-hero'] },
	);
	assert.equal(result.ok, true);

	const bad = validateTemplateManifest(
		{
			schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
			template: 'template-landing.php',
			composition: [{ id: 'both', partial: 'landing-hero', properties: [{ name: 'a', type: 'string' }] }],
		},
		{ partialSlugs: ['landing-hero'] },
	);
	assert.equal(bad.ok, false);
});

test('validateTemplateManifest accepts mixed composition', () => {
	const result = validateTemplateManifest(
		{
			schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
			template: 'template-landing.php',
			composition: [
				{ id: 'seo', partial: 'page-meta' },
				{
					id: 'hero',
					items: [{ id: 'hero-main', partial: 'landing-hero' }],
				},
			],
		},
		{ partialSlugs: ['page-meta', 'landing-hero'] },
	);
	assert.equal(result.ok, true);
});

test('parseSectionFlag parses id:partial', () => {
	assert.deepEqual(parseSectionFlag('hero-main:landing-hero'), { id: 'hero-main', partial: 'landing-hero' });
	assert.throws(() => parseSectionFlag('bad id:hero'), /Invalid composition id/);
});

test('resolveWithin keeps a path inside its root, or returns null', () => {
	assert.equal(resolveWithin('/theme', 'partials/hero.php'), '/theme/partials/hero.php');
	assert.equal(resolveWithin('/theme', './a/../b.txt'), '/theme/b.txt');

	// Escapes, absolute paths, and the root itself are all refused.
	assert.equal(resolveWithin('/theme', '../../../../.ssh/id_rsa'), null);
	assert.equal(resolveWithin('/theme', '/etc/passwd'), null);
	assert.equal(resolveWithin('/theme', '.'), null);
	assert.equal(resolveWithin('/theme', ''), null);
});
