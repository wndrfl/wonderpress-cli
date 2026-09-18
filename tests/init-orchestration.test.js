import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as core from '../src/core.js';
import * as env from '../src/env/index.js';
import * as server from '../src/server.js';

/**
 * `init`'s orchestration, driven by a recording fake backend.
 *
 * These are the first non-gated tests of init. They are possible because
 * provisioning now sits behind a backend: activate a fake and init's lifecycle
 * can be observed without MySQL, WP-CLI, or a network.
 *
 * Scope is deliberately the failure paths and the call order. The success path
 * runs on past provisioning into `installCore`, which shells out to Composer
 * and reaches the network — that belongs to the gated e2e, not here. The
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
	// Provisioning fails so init returns before installCore reaches the
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

// --- where the core version lives ---
//
// Reproducibility used to rest on a pinned git tag held here. It rests on the
// theme's composer.json constraint and its lock file now, which is why the CLI
// names the package and nothing more. Restating a constraint here would
// reintroduce exactly the drift the pin existed to prevent: two sources of
// truth that can disagree, with the CLI quietly winning.

test('the CLI names the core package without restating its version', () => {
	assert.match(core.CORE_PACKAGE, /^[a-z0-9]([a-z0-9._-]*)\/[a-z0-9]([a-z0-9._-]*)$/, 'must be a bare vendor/package name');

	for (const smuggled of [':', '@', '#', '^', '~', '*']) {
		assert.ok(! core.CORE_PACKAGE.includes(smuggled), `"${smuggled}" would make this a version constraint`);
	}
});

// --- teardown ---
//
// wp-env derives an environment's identity from the path it was started in. A
// directory removed before its containers leaves them running, holding the
// port, and unnameable by any later `wp-env destroy` — so --clean-slate must
// tear down FIRST. There were already five orphaned volumes on the machine
// this was found on.

test('--clean-slate tears the environment down before deleting its directory', async () => {
	const backend = fakeBackend();
	backend.destroy = async function () { backend.calls.push('destroy'); return { ok: true, errors: [] }; };

	const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-wipe-')));
	const target = path.join(parent, 'env');
	fs.ensureDirSync(target);
	fs.writeFileSync(path.join(target, '.wonderpressrc'), '{}');

	const cwd = process.cwd();
	const exitCode = process.exitCode;
	env.activate(backend);
	try {
		await core.init(target, { interactive: false, yes: true, cleanSlate: true, wp: {}, db: {} });

		const order = backend.calls.filter((c) => c === 'destroy' || c === 'provision');
		assert.equal(order[0], 'destroy', 'teardown must come before anything rebuilds');
	} finally {
		env.reset();
		process.chdir(cwd);
		process.exitCode = exitCode;
		fs.removeSync(parent);
	}
});

test('a backend with nothing to tear down is not an error', async () => {
	const backend = fakeBackend();
	delete backend.destroy;

	await withFixture(backend, async (dir) => {
		process.chdir(dir);
		assert.equal(await core.destroy({ '--yes': true }), true);
	});
});

// --- stopping ---
//
// Both backends have always had a stop(); nothing ever called it. A wp-env
// environment could be started by the CLI and only stopped by reaching past it
// to `wp-env stop`.

test('`server stop` reaches the backend', async () => {
	const backend = fakeBackend();
	await withFixture(backend, async (dir) => {
		await server.command('stop', { '--dir': dir });
		assert.ok(backend.calls.includes('stop'), 'the backend was asked to stop');
		assert.ok(!backend.calls.includes('start'), 'and was not started on the way past');
	});
});

test('`server` with no subcommand still starts, as it always has', async () => {
	const backend = fakeBackend();
	await withFixture(backend, async (dir) => {
		await server.command(undefined, { '--dir': dir });
		assert.ok(backend.calls.includes('start'));
	});
});

// --- init must not re-namespace a project that already has one ---
//
// `init` is not only run on empty directories. It rebuilds, it repairs, and
// after `destroy` it is how a project comes back — and it used to reset the
// namespace to the default every time. Blocks created afterwards would land in
// a different namespace than the blocks already on the client's pages.

test('a rebuild keeps the namespace the project already uses', async () => {
	const backend = fakeBackend();
	await withFixture(backend, async (dir) => {
		fs.writeFileSync(path.join(dir, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
		process.chdir(dir);

		await core.init(dir, { interactive: false, yes: true, wp: {}, db: {} });

		const rc = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpressrc'), 'utf8'));
		assert.equal(rc.namespace, 'acme', 'the default must not overwrite a recorded namespace');
	});
});

test('an explicit --namespace still wins, on a project that has none', async () => {
	const backend = fakeBackend();
	await withFixture(backend, async (dir) => {
		process.chdir(dir);
		await core.init(dir, { interactive: false, yes: true, namespace: 'acme', wp: {}, db: {} });

		const rc = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpressrc'), 'utf8'));
		assert.equal(rc.namespace, 'acme');
	});
});

test('a project with no namespace at all falls back to the default', async () => {
	const backend = fakeBackend();
	await withFixture(backend, async (dir) => {
		process.chdir(dir);
		await core.init(dir, { interactive: false, yes: true, wp: {}, db: {} });

		const rc = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpressrc'), 'utf8'));
		assert.equal(rc.namespace, 'wonderpress');
	});
});

// --- the core source override ---
//
// Exists so an unreleased core can be tested through `init` without tagging
// one. Before it, trying a core change meant cutting a release for it.

test('there is no override by default', () => {
	const saved = { repo: process.env.WONDERPRESS_CORE_REPO, ref: process.env.WONDERPRESS_CORE_REF };
	delete process.env.WONDERPRESS_CORE_REPO;
	delete process.env.WONDERPRESS_CORE_REF;
	try {
		// null, not an object naming the defaults: an override is a thing the
		// CLI does TO a theme's manifest, so "no override" has to be
		// distinguishable from "override that happens to match".
		assert.equal(core.resolveCoreOverride(), null);
	} finally {
		if (saved.repo !== undefined) process.env.WONDERPRESS_CORE_REPO = saved.repo;
		if (saved.ref !== undefined) process.env.WONDERPRESS_CORE_REF = saved.ref;
	}
});

test('the environment can point core at a local checkout and a branch', () => {
	const saved = { repo: process.env.WONDERPRESS_CORE_REPO, ref: process.env.WONDERPRESS_CORE_REF };
	process.env.WONDERPRESS_CORE_REPO = '/tmp/wonderpress-core';
	process.env.WONDERPRESS_CORE_REF = 'dev-feat/whatever';
	try {
		const override = core.resolveCoreOverride();
		assert.equal(override.repo, '/tmp/wonderpress-core');
		assert.equal(override.ref, 'dev-feat/whatever');
	} finally {
		delete process.env.WONDERPRESS_CORE_REPO;
		delete process.env.WONDERPRESS_CORE_REF;
		if (saved.repo !== undefined) process.env.WONDERPRESS_CORE_REPO = saved.repo;
		if (saved.ref !== undefined) process.env.WONDERPRESS_CORE_REF = saved.ref;
	}
});

test('either half of the override is enough on its own', () => {
	const saved = { repo: process.env.WONDERPRESS_CORE_REPO, ref: process.env.WONDERPRESS_CORE_REF };
	delete process.env.WONDERPRESS_CORE_REPO;
	process.env.WONDERPRESS_CORE_REF = 'dev-master';
	try {
		const override = core.resolveCoreOverride();
		assert.notEqual(override, null, 'a ref alone is still an override');
		assert.equal(override.repo, null, 'an unset repo stays null so the caller can fall back to CORE_REPO');
		assert.equal(override.ref, 'dev-master');
	} finally {
		delete process.env.WONDERPRESS_CORE_REF;
		if (saved.repo !== undefined) process.env.WONDERPRESS_CORE_REPO = saved.repo;
		if (saved.ref !== undefined) process.env.WONDERPRESS_CORE_REF = saved.ref;
	}
});
