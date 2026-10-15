import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sh from 'shelljs';
import { ensureShellExecPath } from '../src/shell-exec-path.js';

/**
 * The desktop app runs the CLI on Electron's own Node (ELECTRON_RUN_AS_NODE=1).
 * shelljs sees `process.versions.electron` and leaves `config.execPath` null,
 * so every synchronous `sh.exec` returns undefined and anything exec-backed
 * (doctor, lint, composer, the host backend) throws. The preload fixture fakes
 * that one signal; these tests pin that the CLI still answers.
 **/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'fake-electron.cjs');

function cliAsElectron(argv) {
	return spawnSync(process.execPath, ['-r', PRELOAD, BIN, ...argv], { encoding: 'utf8', env: { ...process.env, WONDERPRESS_ENV: '' } });
}

function envelope(result) {
	const lines = String(result.stdout).split('\n').filter((l) => l.trim());
	assert.equal(lines.length, 1, `expected exactly one stdout line, got:\n${result.stdout}\nstderr:\n${result.stderr}`);
	return JSON.parse(lines[0]);
}

test('the preload really makes shelljs drop execPath', () => {
	const r = spawnSync(process.execPath, ['-r', PRELOAD, '-e', "console.log(JSON.stringify(require('shelljs').config.execPath))"], { encoding: 'utf8' });
	assert.equal(r.stdout.trim(), 'null');
});

test('ensureShellExecPath fills a null execPath and is a no-op on plain Node', () => {
	const fake = { config: { execPath: null } };
	assert.equal(ensureShellExecPath(fake, { versions: {}, execPath: '/x/node' }), '/x/node');

	const already = { config: { execPath: '/already/set' } };
	assert.equal(ensureShellExecPath(already, { versions: {}, execPath: '/x/node' }), '/already/set');

	const electron = { config: { execPath: null } };
	assert.equal(ensureShellExecPath(electron, { versions: { electron: '38.0.0' }, execPath: '/app/Electron' }), '/app/Electron');

	// This very process is plain Node: importing the module changed nothing.
	assert.equal(sh.config.execPath, process.execPath);
});

test('version --format json answers under faked Electron', () => {
	const out = envelope(cliAsElectron(['version', '--format', 'json']));
	assert.equal(out.ok, true);
	assert.equal(out.data.name, '@wndrfl/wonderpress-cli');
	assert.match(out.data.version, /^\d+\.\d+\.\d+/);
});

test('doctor --format json runs its sh.exec-backed checks under faked Electron', () => {
	const result = cliAsElectron(['doctor', '--format', 'json']);
	const out = envelope(result);
	assert.ok(Array.isArray(out.data?.checks), `no checks in ${result.stdout}`);
	assert.ok(out.data.checks.length > 0);
	assert.doesNotMatch(String(result.stderr), /Unable to find a path to the node binary/);
	assert.doesNotMatch(String(result.stderr), /Cannot read properties of undefined/);
	for (const c of out.data.checks) {
		assert.equal(typeof c.ok, 'boolean', `${c.check} has no boolean ok`);
	}
});
