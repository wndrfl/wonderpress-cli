import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	checkPageTemplates,
	parseTemplateRenderCalls,
	stripPhpComments,
} from '../src/template-check.js';
import { validateTemplateManifest, TEMPLATE_MANIFEST_SCHEMA_VERSION } from '../src/validate.js';

function theme() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-template-check-'));
	fs.ensureDirSync(path.join(dir, '.wonderpress/manifest/partials'));
	fs.ensureDirSync(path.join(dir, '.wonderpress/manifest/page-templates'));
	fs.writeFileSync(path.join(dir, '.wonderpress/manifest/partials/headline-stack.json'), JSON.stringify({
		name: 'Headline_Stack',
		slug: 'headline-stack',
	}));
	return dir;
}

function writeTemplate(dir, manifest, php) {
	fs.writeFileSync(
		path.join(dir, '.wonderpress/manifest/page-templates/template-home.json'),
		JSON.stringify(manifest, null, 2),
	);
	if (php !== undefined) {
		fs.writeFileSync(path.join(dir, 'template-home.php'), php);
	}
}

const base = {
	schemaVersion: TEMPLATE_MANIFEST_SCHEMA_VERSION,
	template: 'template-home.php',
	editor: { lock: 'all' },
};

test('stripPhpComments drops scaffold examples and keeps real calls', () => {
	const source = `
// ( new Hero( wonder_partial_props( 'hero', 'hero-main' ) ) )->render();
/* wonder_template_composition_field( 'intro' ); */
$url = 'https://example.com';
( new Headline_Stack( wonder_partial_props( 'headline-stack', 'hero-head' ) ) )->render();
`;
	const calls = parseTemplateRenderCalls(source);
	assert.deepEqual(calls.partials, [{ partial: 'headline-stack', id: 'hero-head' }]);
	assert.deepEqual(calls.fields, []);
	assert.match(stripPhpComments(source), /https:\/\/example.com/);
});

test('checkPartialSlugs flags an unknown partial even when the slug list is empty', () => {
	const result = validateTemplateManifest({
		...base,
		composition: [{ id: 'hero', partial: 'missing' }],
	}, { partialSlugs: [], checkPartialSlugs: true });
	assert.equal(result.ok, false);
	assert.ok(result.errors.some((error) => /unknown partial "missing"/.test(error)));
});

test('a rendered partial and a read fields row pass', () => {
	const dir = theme();
	try {
		writeTemplate(dir, {
			...base,
			composition: [
				{ id: 'hero', label: 'Hero', items: [{ id: 'hero-head', partial: 'headline-stack' }] },
				{
					id: 'intro',
					properties: [{ name: 'lede', type: 'string', required: false, description: '' }],
				},
			],
		}, `<?php
( new Headline_Stack( wonder_partial_props( 'headline-stack', 'hero-head' ) ) )->render();
$intro = wonder_template_composition_field( 'intro' );
`);
		const report = checkPageTemplates(dir);
		assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
	} finally {
		fs.removeSync(dir);
	}
});

test('reports an unknown partial, a missing render, and an undeclared call', () => {
	const dir = theme();
	try {
		writeTemplate(dir, {
			...base,
			composition: [
				{ id: 'hero-head', partial: 'headline-stack' },
				{ id: 'gone', partial: 'not-a-partial' },
			],
		}, `<?php
wonder_template_composition_field( 'intro' );
`);
		const report = checkPageTemplates(dir);
		assert.equal(report.ok, false);
		const messages = report.results[0].issues.map((issue) => issue.message).join('\n');
		assert.match(messages, /unknown partial "not-a-partial"/);
		assert.match(messages, /wonder_partial_props\( 'headline-stack', 'hero-head' \)/);
		assert.match(messages, /wonder_template_composition_field\( 'intro' \)/);
		assert.match(messages, /Composition row "gone"/);
	} finally {
		fs.removeSync(dir);
	}
});

test('wonder_render_template_sections covers partial rows and not field rows', () => {
	const dir = theme();
	try {
		writeTemplate(dir, {
			...base,
			composition: [
				{ id: 'hero-head', partial: 'headline-stack' },
				{
					id: 'intro',
					properties: [{ name: 'lede', type: 'string', required: false, description: '' }],
				},
			],
		}, '<?php wonder_render_template_sections();');
		const report = checkPageTemplates(dir);
		assert.equal(report.ok, false);
		assert.equal(report.results[0].issues.length, 1);
		assert.equal(report.results[0].issues[0].code, 'unrendered_fields');
	} finally {
		fs.removeSync(dir);
	}
});

test('invalid JSON is reported and does not throw', () => {
	const dir = theme();
	try {
		fs.writeFileSync(path.join(dir, '.wonderpress/manifest/page-templates/template-home.json'), '{');
		const report = checkPageTemplates(dir);
		assert.equal(report.ok, false);
		assert.equal(report.results[0].issues[0].code, 'json');
	} finally {
		fs.removeSync(dir);
	}
});

test('commented scaffold calls are not undeclared rows', () => {
	const dir = theme();
	try {
		writeTemplate(dir, {
			...base,
			composition: [{ id: 'hero-head', partial: 'headline-stack' }],
		}, `<?php
( new Headline_Stack( wonder_partial_props('headline-stack', 'hero-head') ) )->render();
// $intro = wonder_template_composition_field( 'intro' );
`);
		const report = checkPageTemplates(dir);
		assert.equal(report.ok, true, JSON.stringify(report.results, null, 2));
	} finally {
		fs.removeSync(dir);
	}
});
