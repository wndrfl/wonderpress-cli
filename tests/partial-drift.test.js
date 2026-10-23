import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paramsFromFlags, writePartial, syncPartialFromManifest } from '../src/partial.js';
import { checkPartialDrift, parseClassPropertyNames } from '../src/partial-drift.js';
import { renderPartialClassSource } from '../src/partial-class.js';

function tmpTheme() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-drift-')), 'wonderpress');
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

test('parseClassPropertyNames reads $properties keys, including the legacy name', () => {
	const keys = `
		'headline' => array(
			'description' => '',
			'format' => 'string',
			'required' => true,
		),
		'photo' => array(
			'description' => '',
			'format' => 'array',
			'required' => false,
		),
	);`;
	assert.deepEqual(parseClassPropertyNames(`protected static $properties = array(${keys});`), ['headline', 'photo']);
	assert.deepEqual(parseClassPropertyNames(`protected static $_properties = array(${keys});`), ['headline', 'photo']);
});

test('checkPartialDrift passes after sync', async () => {
	const dir = tmpTheme();
	try {
		const params = paramsFromFlags({
			'--name': 'Hero',
			'--block': true,
			'--prop': ['title:string:required'],
		});
		await writePartial(params, dir);
		const manifest = JSON.parse(
			fs.readFileSync(path.join(dir, '.wonderpress/manifest/partials/hero.json'), 'utf8'),
		);
		const result = checkPartialDrift(manifest, dir);
		assert.equal(result.ok, true);
		assert.equal(result.issues.length, 0);
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('checkPartialDrift fails when class was edited without manifest sync', async () => {
	const dir = tmpTheme();
	try {
		const params = paramsFromFlags({
			'--name': 'Hero',
			'--block': true,
			'--prop': ['title:string:required'],
		});
		await writePartial(params, dir);
		const manifestPath = path.join(dir, '.wonderpress/manifest/partials/hero.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.properties.push({ name: 'subtitle', type: 'string', required: false, description: '' });
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

		const result = checkPartialDrift(manifest, dir);
		assert.equal(result.ok, false);
		assert.ok(result.issues.some((i) => i.code === 'class_drift' || i.code === 'block_drift'));
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('syncPartialFromManifest clears drift', async () => {
	const dir = tmpTheme();
	try {
		const params = paramsFromFlags({
			'--name': 'Hero',
			'--block': true,
			'--prop': ['title:string:required'],
		});
		await writePartial(params, dir);
		const manifestPath = path.join(dir, '.wonderpress/manifest/partials/hero.json');
		let manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.properties.push({ name: 'subtitle', type: 'string', required: false, description: '' });
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

		syncPartialFromManifest(manifest, dir);
		const result = checkPartialDrift(manifest, dir);
		assert.equal(result.ok, true);
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('renderPartialClassSource includes manifest banner', () => {
	const params = paramsFromFlags({ '--name': 'Hero', '--prop': ['title:string'] });
	const src = renderPartialClassSource(params);
	assert.match(src, /\/\/ <wonderpress:generated>/);
	assert.match(src, /\/\/ <\/wonderpress:generated>/);
	assert.match(src, /\.wonderpress\/manifest\/partials\/hero\.json/);
	assert.match(src, /partial sync Hero/);
	assert.match(src, /protected static \$properties = array\(/);
	assert.match(src, /protected \$partial_template = /);
	assert.doesNotMatch(src, /\$_properties|\$_partial_template/);

	const acf = renderPartialClassSource(paramsFromFlags({ '--name': 'Hero', '--acf': true, '--prop': ['title:string'] }));
	assert.match(acf, /protected \$acf_compatible = true;/);
	assert.doesNotMatch(acf, /\$_acf_compatible/);
});

// Descriptions land inside single-quoted PHP strings. They must arrive there
// as written: not HTML-escaped, and never able to end the string early.
const AWKWARD_DESCRIPTIONS = {
	quote: 'The client\'s own words, e.g. "Fast & friendly".',
	query: 'Query parameters to append (e.g. param1=value1&param2=value2).',
	markup: 'Allows <em>inline</em> HTML and/or a `code` span.',
	share: 'UNC path to the share, e.g. \\\\files\\',
	escaped: 'A literal \\\' and a literal \\\\ stay as typed.',
};

function awkwardParams() {
	const params = paramsFromFlags({ '--name': 'Testimonial', '--prop': Object.keys(AWKWARD_DESCRIPTIONS).map((n) => `${n}:string`) });
	for (const prop of params.properties) {
		prop.description = AWKWARD_DESCRIPTIONS[prop.name];
	}
	return params;
}

function hasPhp() {
	try {
		execFileSync('php', ['-v'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

test('renderPartialClassSource writes descriptions as PHP string literals, not HTML', () => {
	const src = renderPartialClassSource(awkwardParams());
	assert.doesNotMatch(src, /&#39;|&amp;|&quot;|&lt;|&#x3D;|&#x2F;|&#x60;/);
	assert.ok(src.includes(`'description' => 'The client\\'s own words, e.g. "Fast & friendly".',`));
	assert.ok(src.includes(`'description' => 'Query parameters to append (e.g. param1=value1&param2=value2).',`));
	assert.ok(src.includes(`'description' => 'UNC path to the share, e.g. \\\\\\\\files\\\\',`));

	// Text with nothing to escape renders exactly as it always has.
	const plain = paramsFromFlags({ '--name': 'Hero', '--prop': ['title:string'] });
	plain.properties[0].description = 'The headline.';
	assert.ok(renderPartialClassSource(plain).includes(`'description' => 'The headline.',`));
});

test('generated class parses and returns every description verbatim', { skip: !hasPhp() && 'php is not installed' }, async () => {
	const dir = tmpTheme();
	try {
		await writePartial(awkwardParams(), dir);
		const classFile = path.join(dir, 'src/partials/class-testimonial.php');
		execFileSync('php', ['-l', classFile], { stdio: 'pipe' });

		const probe = path.join(dir, 'probe.php');
		fs.writeFileSync(probe, `<?php
namespace Wonderpress_Core\\Partials { abstract class Abstract_Partial {} }
namespace {
	define( 'ABSPATH', __DIR__ );
	require ${JSON.stringify(classFile)};
	$props = ( new ReflectionClass( 'Wonderpress\\Partials\\Testimonial' ) )->getStaticPropertyValue( 'properties' );
	echo json_encode( array_map( fn( $p ) => $p['description'], $props ) );
}
`);
		const read = JSON.parse(execFileSync('php', [probe], { encoding: 'utf8' }));
		assert.deepEqual(read, AWKWARD_DESCRIPTIONS);

		const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/partials/testimonial.json'), 'utf8'));
		assert.equal(checkPartialDrift(manifest, dir).ok, true);
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});
