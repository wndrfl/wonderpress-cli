import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnvelope } from '../src/format.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fmt-'));
	fs.writeFileSync(path.join(dir, '.wonderpressrc'), '{}');
	fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/src/partials'));
	fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/partials'));
	return dir;
}

function run(dir, argv) {
	return spawnSync('node', [BIN, ...argv, '--dir', dir, '--theme', 'smoke'], { encoding: 'utf8' });
}

test('version --format json prints an envelope', () => {
	const result = spawnSync('node', [BIN, 'version', '--format', 'json'], { encoding: 'utf8' });
	const body = parseEnvelope(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.ok, true);
	assert.equal(body.data.name, '@wndrfl/wonderpress-cli');
	assert.match(body.data.version, /^\d+\.\d+\.\d+/);
});

test('partial list --format json is parseable', () => {
	const dir = makeFixture();
	try {
		const created = run(dir, ['partial', 'create', '--name', 'Smoke_Test', '--block']);
		assert.equal(created.status, 0, created.stdout + created.stderr);

		const listed = run(dir, ['partial', 'list', '--format', 'json']);
		const body = parseEnvelope(listed.stdout);
		assert.equal(listed.status, 0);
		assert.equal(body.ok, true);
		assert.equal(body.partials, undefined);
		assert.equal(body.data.partials.length, 1);
		assert.equal(body.data.partials[0].slug, 'smoke-test');
		assert.equal(body.data.partials[0].block, 'smoke/smoke-test');
		assert.doesNotMatch(listed.stdout, /Wonderpress INFO/);
	} finally {
		fs.removeSync(dir);
	}
});

test('check-drift without a name exits 2 with a JSON usage error', () => {
	const dir = makeFixture();
	try {
		const result = run(dir, ['partial', 'check-drift', '--format', 'json']);
		const body = parseEnvelope(result.stdout);
		assert.equal(result.status, 2);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'usage');
	} finally {
		fs.removeSync(dir);
	}
});

test('check-drift --format json fails when the class drifted', () => {
	const dir = makeFixture();
	try {
		run(dir, ['partial', 'create', '--name', 'Hero', '--block', '--prop', 'title:string:required']);
		const manifestPath = path.join(dir, 'wp-content/themes/smoke/.wonderpress/manifest/partials/hero.json');
		const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
		manifest.properties.push({ name: 'subtitle', type: 'string', required: false, description: '' });
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

		const result = run(dir, ['partial', 'check-drift', 'Hero', '--format', 'json']);
		const body = parseEnvelope(result.stdout);
		assert.equal(result.status, 1);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'drift');
		assert.ok(body.data.results.some((r) => r.ok === false));
	} finally {
		fs.removeSync(dir);
	}
});

test('sync --dry-run --format json returns a plan', () => {
	const dir = makeFixture();
	try {
		run(dir, ['partial', 'create', '--name', 'Hero', '--block']);
		const result = run(dir, ['partial', 'sync', 'Hero', '--dry-run', '--format', 'json']);
		const body = parseEnvelope(result.stdout);
		assert.equal(result.status, 0);
		assert.equal(body.ok, true);
		assert.equal(body.data.dryRun, true);
		assert.equal(body.data.plans[0].slug, 'hero');
	} finally {
		fs.removeSync(dir);
	}
});
