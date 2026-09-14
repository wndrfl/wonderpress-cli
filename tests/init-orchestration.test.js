import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as core from '../src/core.js';
import * as env from '../src/env/index.js';

/**
 * `init`'s orchestration, driven by a recording fake backend.
 *
 * These are the first non-gated tests of init. They are possible because
 * provisioning now sits behind a backend: activate a fake and init's lifecycle
 * can be observed without MySQL, WP-CLI, or a network.
 *
 * Scope is deliberately the failure paths and the call order. The success path
 * runs on past provisioning into `installMuPlugin`, which git-clones
 * wonderpress-core from GitHub — that belongs to the gated e2e, not here. The
 * fixture pre-creates a `.wonderpressrc` so init treats the directory as an
 * existing environment and skips the scaffold clone and the Static Kit install.
 **/

function fakeBackend(overrides = {}) {

	const calls = [];

	const backend = {
		calls,
		name: 'fake',
		capabilities: { honorsDbFlags: true, honorsSiteHostname: true, detachedServer: false },
		async preflight() { calls.push('preflight'); return overrides.preflight ?? { ok: true, errors: [] }; },
		async prepare() { calls.push('prepare'); return overrides.prepare ?? { ok: true, errors: [] }; },
		async provision() { calls.push('provision'); return overrides.provision ?? { ok: true, errors: [] }; },
		wpCli(cmd) { calls.push(`wpCli:${Array.isArray(cmd) ? cmd.join(' ') : cmd}`); return { code: 0, stdout: '[]', stderr: '' }; },
		async start() { calls.push('start'); return { url: null, detached: false }; },
		async stop() { calls.push('stop'); return true; },
	};

	return backend;
}

function fixture() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-init-orch-')));
	// The marker makes init treat this as an existing environment, so it skips
	// the git clone of the development-environment scaffold and the Static Kit
	// install — both of which need the network.
	fs.writeFileSync(path.join(dir, '.wonderpressrc'), '{}');
	return dir;
}

async function withFixture(backend, fn) {
	const cwd = process.cwd();
	const dir = fixture();
	const exitCode = process.exitCode;
	env.activate(backend);
	try {
		return await fn(dir);
	} finally {
		env.reset();
		process.chdir(cwd);
		process.exitCode = exitCode;
		fs.removeSync(dir);
	}
}

test('a failing preflight stops init before it touches anything else', async () => {
	const backend = fakeBackend({ preflight: { ok: false, errors: ['no tooling here'] } });

	await withFixture(backend, async (dir) => {
		await core.init(dir, { interactive: false, yes: true });

		assert.deepEqual(backend.calls, ['preflight'], 'nothing should run after a failed preflight');
	});
});

test('the lifecycle runs preflight, then prepare, then provision', async () => {
	// Provisioning fails so init returns before installMuPlugin reaches the
	// network. That still pins the order of everything ahead of it.
	const backend = fakeBackend({ provision: { ok: false, errors: ['could not provision'] } });

	await withFixture(backend, async (dir) => {
		await core.init(dir, { interactive: false, yes: true });

		assert.deepEqual(backend.calls, ['preflight', 'prepare', 'provision']);
	});
});

test('a failing provision fails the process and does not claim success', async () => {
	const backend = fakeBackend({ provision: { ok: false, errors: ['could not provision'] } });

	await withFixture(backend, async (dir) => {
		process.exitCode = 0;
		const result = await core.init(dir, { interactive: false, yes: true });

		// The whole point: init used to discard this and print "The Wonderpress
		// environment has been initialized!" over a broken environment.
		assert.equal(result, false, 'init should report failure');
		assert.equal(process.exitCode, 1, 'init should fail the process');
	});
});

test('a failing prepare stops init before provisioning', async () => {
	const backend = fakeBackend({ prepare: { ok: false, errors: ['could not prepare'] } });

	await withFixture(backend, async (dir) => {
		process.exitCode = 0;
		const result = await core.init(dir, { interactive: false, yes: true });

		assert.deepEqual(backend.calls, ['preflight', 'prepare']);
		assert.equal(result, false);
		assert.equal(process.exitCode, 1);
	});
});

test('a lifecycle hook that returns nothing counts as success', async () => {
	// Backends are free to leave a hook as a no-op; an undefined return must not
	// read as failure.
	const backend = fakeBackend({ prepare: undefined, provision: { ok: false, errors: ['stop here'] } });
	backend.prepare = async function () { this.calls.push('prepare'); };

	await withFixture(backend, async (dir) => {
		await core.init(dir, { interactive: false, yes: true });

		assert.deepEqual(backend.calls, ['preflight', 'prepare', 'provision']);
	});
});

test('a failing preflight exits non-zero', async () => {
	// It used to `return 0` — an init that refused to run still told the shell
	// it had succeeded, which is the same class of lie as claiming success over
	// a failed provision.
	const backend = fakeBackend({ preflight: { ok: false, errors: ['no tooling here'] } });

	await withFixture(backend, async (dir) => {
		process.exitCode = 0;
		const result = await core.init(dir, { interactive: false, yes: true });

		assert.equal(result, false);
		assert.equal(process.exitCode, 1);
	});
});
