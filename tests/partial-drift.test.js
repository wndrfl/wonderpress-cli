import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { paramsFromFlags, writePartial, syncPartialFromManifest } from '../src/partial.js';
import {
	checkPartialDrift,
	parseClassPropertyNames,
	renderPartialClassSource,
} from '../src/partial-drift.js';

function tmpTheme() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-drift-')), 'wonderpress');
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

test('parseClassPropertyNames reads $_properties keys', () => {
	const sample = `protected static $_properties = array(
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
	assert.deepEqual(parseClassPropertyNames(sample), ['headline', 'photo']);
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
	assert.match(src, /GENERATED FILE/);
	assert.match(src, /\.wonderpress\/manifest\/partials\/hero\.json/);
	assert.match(src, /partial sync Hero/);
});
