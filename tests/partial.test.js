import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	paramsFromFlags,
	paramsFromJson,
	writePartial,
	validateParams,
} from '../src/partial.js';

function tmpTheme() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-partial-'));
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

test('paramsFromFlags maps flags to params', () => {
	const p = paramsFromFlags({ '--name': 'Testimonial', '--acf': true, '--prop': ['quote:string:required', 'company:string'] });
	assert.equal(p.class_name, 'Testimonial');
	assert.equal(p.is_acf_compatible, true);
	assert.equal(p.has_partial_template, true);
	assert.equal(p.partial_template_name, 'testimonial.php');
	assert.deepEqual(p.properties, [
		{ name: 'quote', type: 'string', required: true, description: '' },
		{ name: 'company', type: 'string', required: false, description: '' },
	]);
});

test('paramsFromJson maps the canonical contract', () => {
	const p = paramsFromJson(JSON.stringify({ name: 'Hero', acf_compatible: false, template: true, properties: [{ name: 'title', type: 'string', required: true }] }));
	assert.equal(p.class_name, 'Hero');
	assert.equal(p.is_acf_compatible, false);
	assert.equal(p.properties[0].required, true);
});

test('writePartial: flag form and json form are byte-identical', () => {
	const spec = {
		name: 'Testimonial', acf_compatible: true, template: true, properties: [
			{ name: 'quote', type: 'string', required: true },
			{ name: 'author', type: 'string', required: true },
			{ name: 'company', type: 'string', required: false },
		],
	};
	const flags = { '--name': 'Testimonial', '--acf': true, '--prop': ['quote:string:required', 'author:string:required', 'company:string'] };

	const t1 = tmpTheme();
	const t2 = tmpTheme();
	try {
		const pFlags = paramsFromFlags(flags);
		const pJson = paramsFromJson(JSON.stringify(spec));
		validateParams(pFlags);
		validateParams(pJson);
		writePartial(pFlags, t1);
		writePartial(pJson, t2);

		const a = fs.readFileSync(path.join(t1, 'src/partials/class-testimonial.php'), 'utf8');
		const b = fs.readFileSync(path.join(t2, 'src/partials/class-testimonial.php'), 'utf8');
		assert.equal(a, b);

		// $_properties must be unescaped (no leftover heredoc \$)
		assert.match(a, /protected static \$_properties/);
		assert.doesNotMatch(a, /\\\$/);

		// the view template is written too
		assert.ok(fs.existsSync(path.join(t1, 'partials/testimonial.php')));
	} finally {
		fs.removeSync(t1);
		fs.removeSync(t2);
	}
});

test('validateParams rejects a bad class name', () => {
	assert.throws(() => validateParams({ class_name: 'bad-name', has_partial_template: false, properties: [] }), /Invalid class name/);
});

// --- spine emission (block.json / style / manifest) ---

test('writePartial emits block.json with attributes mapped from props', () => {
	const dir = tmpTheme();
	try {
		writePartial(paramsFromFlags({ '--name': 'Testimonial', '--prop': ['quote:string:required', 'featured:boolean'] }), dir);
		const block = JSON.parse(fs.readFileSync(path.join(dir, 'blocks/testimonial/block.json'), 'utf8'));
		assert.equal(block.name, 'wonderpress/testimonial');
		assert.equal(block.title, 'Testimonial');
		assert.equal(block.attributes.quote.type, 'string');
		assert.equal(block.attributes.featured.type, 'boolean');
	} finally {
		fs.removeSync(dir);
	}
});

test('writePartial emits an agent manifest mirroring properties + artifact paths', () => {
	const dir = tmpTheme();
	try {
		writePartial(paramsFromFlags({ '--name': 'My_Cool_Thing', '--acf': true, '--prop': ['body:string:required'] }), dir);
		const m = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/my-cool-thing.json'), 'utf8'));
		assert.equal(m.name, 'My_Cool_Thing');
		assert.equal(m.slug, 'my-cool-thing');
		assert.equal(m.block, 'wonderpress/my-cool-thing');
		assert.equal(m.acf_compatible, true);
		assert.deepEqual(m.properties, [{ name: 'body', type: 'string', required: true, description: '' }]);
		assert.equal(m.artifacts.class, 'src/partials/class-my-cool-thing.php');
		assert.equal(m.artifacts.block, 'blocks/my-cool-thing/block.json');
	} finally {
		fs.removeSync(dir);
	}
});

test('emit opt-outs suppress block.json + manifest (class still written)', () => {
	const dir = tmpTheme();
	try {
		writePartial(paramsFromFlags({ '--name': 'Solo', '--no-block': true, '--no-manifest': true }), dir);
		assert.ok(!fs.existsSync(path.join(dir, 'blocks/solo/block.json')));
		assert.ok(!fs.existsSync(path.join(dir, '.wonderpress/manifest/solo.json')));
		assert.ok(fs.existsSync(path.join(dir, 'src/partials/class-solo.php')));
	} finally {
		fs.removeSync(dir);
	}
});

test('block.json + manifest are identical across flag and json paths', () => {
	const spec = {
		name: 'Testimonial', acf_compatible: true, template: true, properties: [
			{ name: 'quote', type: 'string', required: true },
			{ name: 'featured', type: 'boolean', required: false },
		],
	};
	const flags = { '--name': 'Testimonial', '--acf': true, '--prop': ['quote:string:required', 'featured:boolean'] };
	const t1 = tmpTheme();
	const t2 = tmpTheme();
	try {
		writePartial(paramsFromFlags(flags), t1);
		writePartial(paramsFromJson(JSON.stringify(spec)), t2);
		for (const rel of ['blocks/testimonial/block.json', '.wonderpress/manifest/testimonial.json']) {
			assert.equal(fs.readFileSync(path.join(t1, rel), 'utf8'), fs.readFileSync(path.join(t2, rel), 'utf8'), rel);
		}
	} finally {
		fs.removeSync(t1);
		fs.removeSync(t2);
	}
});
