import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { resolveBackendName } from '../src/env/index.js';
import * as wpEnv from '../src/env/wp-env.js';
import * as hostEnv from '../src/env/host.js';

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
