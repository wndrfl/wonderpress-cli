import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	isValidClassName,
	isValidTemplateName,
	isValidPropType,
	parsePropFlag,
	classNameToFileSlug,
	defaultTemplateName,
	isSafeSlug,
	resolveWithin,
	PROP_TYPES,
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
	assert.ok(!isValidPropType('image'));
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

test('resolveWithin keeps a path inside its root, or returns null', () => {
	assert.equal(resolveWithin('/theme', 'partials/hero.php'), '/theme/partials/hero.php');
	assert.equal(resolveWithin('/theme', './a/../b.txt'), '/theme/b.txt');

	// Escapes, absolute paths, and the root itself are all refused.
	assert.equal(resolveWithin('/theme', '../../../../.ssh/id_rsa'), null);
	assert.equal(resolveWithin('/theme', '/etc/passwd'), null);
	assert.equal(resolveWithin('/theme', '.'), null);
	assert.equal(resolveWithin('/theme', ''), null);
});
