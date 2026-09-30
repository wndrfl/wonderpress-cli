import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as env from '../src/env/index.js';
import { resolveBackendName } from '../src/env/index.js';
import * as wpEnv from '../src/env/wp-env.js';
import * as hostEnv from '../src/env/host.js';
import * as core from '../src/core.js';

/**
 * Backend resolution precedence. Pure, so the whole table is cheap to pin.
 *
 * The tier that matters most is the last one: an environment with no markers
 * of any kind resolves to `host`. Every WonderPress site built before this
 * feature existed is in exactly that state, and must keep using the backend it
 * has always used.
 **/

test('an environment with no markers resolves to host', () => {
	const r = resolveBackendName({});
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'default');
});

test('undefined inputs resolve to host rather than throwing', () => {
	assert.equal(resolveBackendName().name, 'host');
	assert.equal(resolveBackendName({ flag: undefined, envVar: undefined, persisted: undefined, detected: undefined }).name, 'host');
});

test('the flag wins over everything', () => {
	const r = resolveBackendName({ flag: 'host', envVar: 'wp-env', persisted: 'wp-env', detected: 'wp-env' });
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'flag');
});

test('the env var wins over what is recorded', () => {
	const r = resolveBackendName({ envVar: 'host', persisted: 'wp-env' });
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'env');
});

test('a recorded backend wins over detection', () => {
	const r = resolveBackendName({ persisted: 'host', detected: 'wp-env' });
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'persisted');
});

test('a .wp-env.json is detected when nothing was recorded', () => {
	// Keeps an environment working after a git checkout reverts .wonderpressrc.
	const r = resolveBackendName({ detected: 'wp-env' });
	assert.equal(r.name, 'wp-env');
	assert.equal(r.source, 'detected');
});

test('an explicit choice contradicting the record is flagged', () => {
	const r = resolveBackendName({ flag: 'host', persisted: 'wp-env' });
	assert.equal(r.mismatch, true);
	assert.equal(r.persisted, 'wp-env');
});

test('agreeing with the record is not a mismatch', () => {
	assert.equal(resolveBackendName({ flag: 'wp-env', persisted: 'wp-env' }).mismatch, false);
});

test('a recorded value alone is never a mismatch', () => {
	// Nothing contradicts it, so there is nothing to warn about.
	assert.equal(resolveBackendName({ persisted: 'wp-env' }).mismatch, false);
});

test('an unknown name is surfaced, not silently ignored', () => {
	const r = resolveBackendName({ flag: 'bogus' });
	assert.equal(r.unknown, 'bogus');
	assert.equal(resolveBackendName({ envVar: 'nope' }).unknown, 'nope');
});

test('an unrecognised recorded value falls back instead of failing', () => {
	// A newer CLI wrote a backend this one does not have: degrade to host
	// rather than refusing to run at all.
	const r = resolveBackendName({ persisted: 'future-backend' });
	assert.equal(r.name, 'host');
	assert.equal(r.unknown, null);
});

// --- rebinding once the root is known ---
//
// cli.js resolves from the shell's cwd before dispatch. A command pointed at a
// wp-env project from outside it (`--dir sandbox/wp` from the repo root, or an
// MCP call carrying `dir`) used to keep the host backend the cwd resolved to,
// and ran `wp` bare against a wp-config.php whose DB_HOST is a Docker service
// name — surfacing as "the CLI can't reach the DB".

function wpEnvProject() {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-rebind-')));
	fs.writeFileSync(path.join(dir, '.wonderpressrc'), JSON.stringify({ environment: { backend: 'wp-env' } }));
	fs.writeFileSync(path.join(dir, '.wp-env.json'), '{}');
	return dir;
}

test('finding the environment root rebinds to the backend it was built with', async () => {
	const project = wpEnvProject();
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-outside-')));
	const cwd = process.cwd();
	try {
		process.chdir(outside);
		env.resolve({ root: outside });
		assert.equal(env.getCurrent().name, 'host', 'from outside any environment, the cwd resolves to host');

		process.chdir(project);
		assert.equal(await core.setCwdToEnvironmentRoot(), true);
		assert.equal(env.getCurrent().name, 'wp-env');
	} finally {
		env.reset();
		process.chdir(cwd);
		fs.removeSync(project);
		fs.removeSync(outside);
	}
});

test('rebinding still honors an explicit --env choice', () => {
	const project = wpEnvProject();
	try {
		env.resolve({ flag: 'host', root: os.tmpdir() });
		const r = env.rebind(project);
		assert.equal(env.getCurrent().name, 'host');
		assert.equal(r.mismatch, true, 'the contradiction is still reported');
	} finally {
		env.reset();
		fs.removeSync(project);
	}
});

test('rebinding honors WONDERPRESS_ENV the same way', () => {
	const project = wpEnvProject();
	try {
		env.resolve({ envVar: 'host', root: os.tmpdir() });
		env.rebind(project);
		assert.equal(env.getCurrent().name, 'host');
	} finally {
		env.reset();
		fs.removeSync(project);
	}
});

test('rebinding leaves an injected test backend alone', () => {
	const project = wpEnvProject();
	const fake = { name: 'fake' };
	try {
		env.activate(fake);
		assert.equal(env.rebind(project), null);
		assert.equal(env.getCurrent(), fake);
	} finally {
		env.reset();
		fs.removeSync(project);
	}
});

test('rebinding to the same answer keeps the same backend instance', () => {
	const project = wpEnvProject();
	try {
		env.resolve({ root: project });
		const before = env.getCurrent();
		env.rebind(project);
		assert.equal(env.getCurrent(), before);
	} finally {
		env.reset();
		fs.removeSync(project);
	}
});

// --- where the site is ---
//
// `init` used to end on "initialized!" and leave the one question everybody has
// unanswered. It bit hardest on wp-env, which finishes with the site already up
// at a port only its own config knows.

test('wp-env reports the port its config actually carries', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-url-'));
	const cwd = process.cwd();
	try {
		fs.writeFileSync(path.join(dir, '.wp-env.json'), JSON.stringify({ port: 9123 }));
		process.chdir(dir);
		assert.equal(wpEnv.create().siteUrl(), 'http://localhost:9123');
	} finally {
		process.chdir(cwd);
		fs.removeSync(dir);
	}
});

test('wp-env falls back to the default port when there is no config yet', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-url-'));
	const cwd = process.cwd();
	try {
		process.chdir(dir);
		assert.equal(wpEnv.create().siteUrl(), 'http://localhost:8888');
	} finally {
		process.chdir(cwd);
		fs.removeSync(dir);
	}
});

test('the host backend reports the url it was given, with a scheme', () => {
	const host = hostEnv.create();
	assert.equal(host.siteUrl({ wp: { url: 'acme.localhost:8080' } }), 'http://acme.localhost:8080');
	assert.equal(host.siteUrl({ wp: { url: 'https://acme.test' } }), 'https://acme.test', 'an explicit scheme is left alone');
});

// --- who the admin is ---
//
// On wp-env, `wp-env start` installs WordPress and creates the first user, so
// WonderPress never prompts for one and nothing the caller passed describes it.
// Someone who just ran init has no way to guess the password.

test('wp-env reports its own fixed default login', () => {
	const login = wpEnv.create().adminLogin({ wp: {} });
	assert.equal(login.user, 'admin');
	assert.equal(login.password, 'password', "wp-env's documented default, which the user did not choose");
	assert.match(login.note, /default/);
});

test('wp-env stops repeating the password once the user supplies one', () => {
	const login = wpEnv.create().adminLogin({ wp: { adminPassword: 'hunter2' } });
	assert.equal(login.password, null, 'a password the user chose is not ours to echo');
	assert.equal(login.note, null);
});

test('the host backend never echoes a password, and uses the requested username', () => {
	const login = hostEnv.create().adminLogin({ wp: { adminUser: 'johnnie', adminPassword: 'hunter2' } });
	assert.equal(login.user, 'johnnie');
	assert.equal(login.password, null);
	assert.match(login.note, /you set/);
});

// --- flags a backend cannot honor ---

test('wp-env declares that it cannot honor a chosen admin username', () => {
	assert.equal(wpEnv.create().capabilities.honorsAdminUser, false);
});

test('the host backend can, because `wp core install` names the first user', () => {
	assert.equal(hostEnv.create().capabilities.honorsAdminUser, true);
});
