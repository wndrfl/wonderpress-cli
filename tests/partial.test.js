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
