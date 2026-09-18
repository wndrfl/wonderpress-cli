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
	validateTemplateManifest,
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
