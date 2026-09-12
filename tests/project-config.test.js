import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as config from '../src/config.js';

/**
 * Reading and writing an environment's .wonderpressrc.
 *
 * This replaced a dead `get()` stub built on `rc`, which was the wrong tool:
 * rc merges ~/.wonderpressrc, wonderpress_* env vars, every file found walking
 * up from cwd, and process.argv via minimist — so `partial create --name Hero`
 * would have injected `name: 'Hero'` into the config.
 **/

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-cfg-')));
}

test('a missing config reads as missing, not as an error', () => {
	const dir = tmp();
	try {
		const r = config.read(dir);
		assert.equal(r.format, 'missing');
		assert.deepEqual(r.data, {});
		assert.equal(config.getBackend(dir), null);
	} finally { fs.removeSync(dir); }
});

test('writes create the file, and round-trip', () => {
	const dir = tmp();
	try {
		assert.equal(config.write(dir, { environment: { backend: 'wp-env' } }), true);
		assert.equal(config.getBackend(dir), 'wp-env');
		assert.equal(config.read(dir).format, 'json');
	} finally { fs.removeSync(dir); }
});

test('writing preserves keys it does not touch', () => {
	const dir = tmp();
	try {
		fs.writeFileSync(path.join(dir, '.wonderpressrc'), JSON.stringify({ ignore: ['.git'] }));
		config.write(dir, { environment: { backend: 'wp-env' } });

		const { data } = config.read(dir);
		assert.deepEqual(data.ignore, ['.git'], 'existing keys must survive');
		assert.equal(data.environment.backend, 'wp-env');
	} finally { fs.removeSync(dir); }
});

test('an unparseable config is never clobbered', () => {
	const dir = tmp();
	try {
		// .wonderpressrc is an rc-format file and may legally be INI. Not ours
		// to rewrite just because we cannot parse it as JSON.
		const ini = '[settings]\nfoo = bar\n';
		fs.writeFileSync(path.join(dir, '.wonderpressrc'), ini);

		assert.equal(config.read(dir).format, 'unparseable');
		assert.equal(config.write(dir, { environment: { backend: 'wp-env' } }), false);
		assert.equal(fs.readFileSync(path.join(dir, '.wonderpressrc'), 'utf8'), ini, 'file must be untouched');
	} finally { fs.removeSync(dir); }
});

test('the legacy .wonderpress marker is read', () => {
	const dir = tmp();
	try {
		fs.writeFileSync(path.join(dir, '.wonderpress'), JSON.stringify({ environment: { backend: 'wp-env' } }));
		assert.equal(config.getBackend(dir), 'wp-env');
	} finally { fs.removeSync(dir); }
});

test('.wonderpressrc wins over the legacy marker', () => {
	const dir = tmp();
	try {
		fs.writeFileSync(path.join(dir, '.wonderpress'), JSON.stringify({ environment: { backend: 'wp-env' } }));
		fs.writeFileSync(path.join(dir, '.wonderpressrc'), JSON.stringify({ environment: { backend: 'host' } }));
		assert.equal(config.getBackend(dir), 'host');
	} finally { fs.removeSync(dir); }
});

test('a config with no environment key has no backend', () => {
	const dir = tmp();
	try {
		fs.writeFileSync(path.join(dir, '.wonderpressrc'), '{}');
		assert.equal(config.getBackend(dir), null);
	} finally { fs.removeSync(dir); }
});

test('a non-object config does not crash the reader', () => {
	const dir = tmp();
	try {
		fs.writeFileSync(path.join(dir, '.wonderpressrc'), '"just a string"');
		assert.deepEqual(config.read(dir).data, {});
		assert.equal(config.getBackend(dir), null);
	} finally { fs.removeSync(dir); }
});
