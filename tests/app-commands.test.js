import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import * as config from '../src/config.js';
import * as core from '../src/core.js';
import * as doctor from '../src/doctor.js';
import * as env from '../src/env/index.js';
import * as format from '../src/format.js';
import * as server from '../src/server.js';
import { isPortListening, urlTarget } from '../src/env/probe.js';
import { create as createWpEnv, parseWpEnvStatus } from '../src/env/wp-env.js';
import { buildPageTemplateManifestSchema, buildPartialManifestSchema } from '../src/manifest-schema.js';
import pkg from '../package.json' with { type: 'json' };

/**
 * The commands the desktop app drives: `server` in JSON, `doctor`, the
 * manifest schema export, and the cliVersion pin.
 *
 * The app reads exactly one JSON envelope off stdout per invocation, so most of
 * what is pinned here is that contract: one line, the documented shape, and
 * nothing else on stdout — warnings included.
 **/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

function tmp(prefix = 'wp-app-') {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function project(rc = {}) {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, '.wonderpressrc'), JSON.stringify(rc));
	return dir;
}

function cli(argv, opts = {}) {
	return spawnSync('node', [BIN, ...argv], { encoding: 'utf8', cwd: opts.cwd, env: { ...process.env, WONDERPRESS_ENV: '' } });
}

/** stdout must be exactly one envelope line — the app's whole contract. */
function onlyEnvelope(stdout) {
	const lines = String(stdout).split('\n').filter((l) => l.trim());
	assert.equal(lines.length, 1, `expected exactly one stdout line, got:\n${stdout}`);
	return JSON.parse(lines[0]);
}

/**
 * Run `fn` in JSON mode against an injected backend inside a fixture project,
 * collecting what went to stdout via console.log (which is where format.ok and
 * format.fail write).
 **/
async function inJson(backend, fn, rc = {}) {
	const cwd = process.cwd();
	const exitCode = process.exitCode;
	const dir = project(rc);
	const printed = [];
	const original = console.log;
	// JSON mode installs a guard on process.stdout.write. The test runner
	// reports results over this process's stdout, so leaving the guard in
	// place would divert (and lose) its events. Keep the mode, drop the guard:
	// what is under test is what reaches console.log.
	const realWrite = process.stdout.write;
	format.configure({ '--format': 'json' });
	process.stdout.write = realWrite;
	console.log = (line) => printed.push(String(line));
	env.activate(backend);
	try {
		process.exitCode = 0;
		await fn(dir);
		return { printed, exitCode: process.exitCode };
	} finally {
		console.log = original;
		format.reset();
		env.reset();
		process.chdir(cwd);
		process.exitCode = exitCode;
		fs.removeSync(dir);
	}
}

const SERVER_KEYS = ['adminUrl', 'backend', 'detached', 'pid', 'port', 'running', 'url'];

function detachedBackend(overrides = {}) {
	const calls = [];
	return {
		calls,
		name: 'wp-env',
		capabilities: { detachedServer: true },
		siteUrl: () => 'http://localhost:9911',
		async start() { calls.push('start'); return overrides.start ?? { ok: true, errors: [], url: 'http://localhost:9911', detached: true }; },
		async stop() { calls.push('stop'); return overrides.stop ?? true; },
		async status() { calls.push('status'); return { running: true, url: 'http://localhost:9911', port: 9911, pid: null }; },
	};
}

function foregroundBackend() {
	const calls = [];
	return {
		calls,
		name: 'host',
		capabilities: { detachedServer: false },
		siteUrl: () => 'http://localhost:8080',
		async start(opts = {}) {
			calls.push('start');
			// What host.start does in JSON mode: announce once ready, then keep
			// running until the server exits.
			opts.onReady({ url: 'http://localhost:8080', port: 8080, pid: 4242 });
			return { ok: true, url: 'http://localhost:8080', detached: false, pid: 4242, exitCode: 0 };
		},
		async stop() { calls.push('stop'); return true; },
		async status() { calls.push('status'); return { running: false, url: 'http://localhost:8080', port: 8080, pid: null }; },
	};
}

// --- server --format json ---

test('server status --format json reports the detached backend', async () => {
	const backend = detachedBackend();
	const { printed, exitCode } = await inJson(backend, (dir) => server.command('status', { '--dir': dir }));

	assert.equal(printed.length, 1);
	const body = JSON.parse(printed[0]);
	assert.equal(body.ok, true);
	assert.deepEqual(Object.keys(body.data).sort(), SERVER_KEYS);
	assert.deepEqual(body.data, {
		backend: 'wp-env',
		detached: true,
		running: true,
		url: 'http://localhost:9911',
		adminUrl: 'http://localhost:9911/wp-admin',
		port: 9911,
		pid: null,
	});
	assert.equal(exitCode, 0);
	assert.deepEqual(backend.calls, ['status'], 'status must not start anything');
});

test('server start --format json on a detached backend prints one envelope after start', async () => {
	const backend = detachedBackend();
	const { printed } = await inJson(backend, (dir) => server.command('start', { '--dir': dir }));

	assert.equal(printed.length, 1);
	const body = JSON.parse(printed[0]);
	assert.equal(body.ok, true);
	assert.equal(body.data.running, true);
	assert.equal(body.data.detached, true);
	assert.equal(body.data.url, 'http://localhost:9911');
});

test('server start --format json on a foreground backend announces once, from onReady', async () => {
	const backend = foregroundBackend();
	const { printed } = await inJson(backend, (dir) => server.command('start', { '--dir': dir }));

	assert.equal(printed.length, 1, 'the envelope goes out at readiness and nothing follows it');
	const body = JSON.parse(printed[0]);
	assert.equal(body.ok, true);
	assert.equal(body.data.backend, 'host');
	assert.equal(body.data.detached, false);
	assert.equal(body.data.running, true);
	assert.equal(body.data.pid, 4242);
	assert.equal(body.data.port, 8080);
});

test('a failed start is an ok:false envelope with a non-zero exit', async () => {
	const backend = detachedBackend({ start: { ok: false, errors: ['wp-env could not start the environment.'], url: 'http://localhost:9911', detached: true } });
	const { printed, exitCode } = await inJson(backend, (dir) => server.command('start', { '--dir': dir }));

	assert.equal(printed.length, 1);
	const body = JSON.parse(printed[0]);
	assert.equal(body.ok, false);
	assert.equal(body.error.code, 'server');
	assert.match(body.error.message, /could not start/);
	assert.equal(body.data.running, false);
	assert.equal(exitCode, 1);
});

test('server stop --format json returns an envelope', async () => {
	const backend = detachedBackend();
	const { printed } = await inJson(backend, (dir) => server.command('stop', { '--dir': dir }));

	assert.equal(printed.length, 1);
	const body = JSON.parse(printed[0]);
	assert.equal(body.ok, true);
	assert.equal(body.data.running, false);
	assert.ok(backend.calls.includes('stop'));
});

test('server stop on the host reports what is true rather than claiming it stopped', async () => {
	const backend = foregroundBackend();
	const { printed } = await inJson(backend, (dir) => server.command('stop', { '--dir': dir }));

	const body = JSON.parse(printed[0]);
	assert.equal(body.ok, true);
	assert.equal(body.data.detached, false);
	assert.ok(backend.calls.includes('status'), 'the host is probed after stop, not assumed down');
});

test('a failed stop is an ok:false envelope', async () => {
	const backend = detachedBackend({ stop: false });
	const { printed, exitCode } = await inJson(backend, (dir) => server.command('stop', { '--dir': dir }));

	const body = JSON.parse(printed[0]);
	assert.equal(body.ok, false);
	assert.equal(body.error.code, 'server');
	assert.equal(exitCode, 1);
});

test('status on a backend without status() probes its site URL from Node', async () => {
	const listener = net.createServer();
	await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
	const { port } = listener.address();

	try {
		const backend = {
			name: 'fake',
			capabilities: { detachedServer: false },
			siteUrl: () => `http://localhost:${port}`,
			async start() {},
			async stop() { return true; },
		};
		const up = await inJson(backend, (dir) => server.command('status', { '--dir': dir }));
		assert.equal(JSON.parse(up.printed[0]).data.running, true);
		assert.equal(JSON.parse(up.printed[0]).data.port, port);
	} finally {
		await new Promise((resolve) => listener.close(resolve));
	}

	const backend = {
		name: 'fake',
		capabilities: { detachedServer: false },
		siteUrl: () => `http://localhost:${port}`,
		async start() {},
		async stop() { return true; },
	};
	const down = await inJson(backend, (dir) => server.command('status', { '--dir': dir }));
	assert.equal(JSON.parse(down.printed[0]).data.running, false);
});

test('server status outside an environment fails with an envelope', () => {
	const dir = tmp();
	try {
		const result = cli(['server', 'status', '--format', 'json'], { cwd: dir });
		const body = onlyEnvelope(result.stdout);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'environment');
		assert.equal(result.status, 1);
	} finally {
		fs.removeSync(dir);
	}
});

test('server status --format json from the CLI is one envelope for the host backend', () => {
	const dir = project({ environment: { backend: 'host' } });
	try {
		const result = cli(['server', 'status', '--dir', dir, '--format', 'json']);
		const body = onlyEnvelope(result.stdout);
		assert.equal(result.status, 0);
		assert.equal(body.ok, true);
		assert.deepEqual(Object.keys(body.data).sort(), SERVER_KEYS);
		assert.equal(body.data.backend, 'host');
		assert.equal(body.data.detached, false);
		assert.equal(typeof body.data.running, 'boolean');
	} finally {
		fs.removeSync(dir);
	}
});

test('an unknown server subcommand is an error, not a start', () => {
	const dir = project();
	try {
		const result = cli(['server', 'stauts', '--dir', dir, '--format', 'json']);
		const body = onlyEnvelope(result.stdout);
		assert.equal(result.status, 1);
		assert.equal(body.error.code, 'unknown_command');
	} finally {
		fs.removeSync(dir);
	}
});

// --- probes ---

test('urlTarget splits a site URL', () => {
	assert.deepEqual(urlTarget('http://localhost:8888'), { host: 'localhost', port: 8888 });
	assert.deepEqual(urlTarget('localhost:8080'), { host: 'localhost', port: 8080 });
	assert.deepEqual(urlTarget('http://[::1]:8080'), { host: '::1', port: 8080 });
	assert.deepEqual(urlTarget('https://example.test'), { host: 'example.test', port: 443 });
	assert.equal(urlTarget(null), null);
});

test('isPortListening answers by connecting', async () => {
	const listener = net.createServer();
	await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
	const { port } = listener.address();
	assert.equal(await isPortListening(port), true);
	await new Promise((resolve) => listener.close(resolve));
	assert.equal(await isPortListening(port), false);
});

test('localhost is probed over IPv6 too, where macOS binds `wp server`', async (t) => {
	const listener = net.createServer();
	try {
		await new Promise((resolve, reject) => {
			listener.once('error', reject);
			listener.listen(0, '::1', resolve);
		});
	} catch (e) {
		t.skip('no IPv6 loopback on this machine');
		return;
	}
	const { port } = listener.address();
	try {
		assert.equal(await isPortListening(port, 'localhost'), true);
	} finally {
		await new Promise((resolve) => listener.close(resolve));
	}
});

test('wp-env status --json is read, and an older wp-env without it falls through', () => {
	const running = JSON.stringify({ status: 'running', urls: { development: 'http://localhost:8890' }, ports: { development: 8890 } });
	assert.deepEqual(parseWpEnvStatus({ code: 0, stdout: `- Getting environment status.\n${running}\n` }), { running: true, url: 'http://localhost:8890', port: 8890 });
	assert.equal(parseWpEnvStatus({ code: 0, stdout: JSON.stringify({ status: 'stopped', urls: { development: null } }) }).running, false);
	assert.equal(parseWpEnvStatus({ code: 0, stdout: JSON.stringify({ status: 'uninitialized' }) }).running, false);
	assert.equal(parseWpEnvStatus({ code: 1, stdout: '', stderr: 'Unknown command: status' }), null);
	assert.equal(parseWpEnvStatus({ code: 0, stdout: 'not json' }), null);
});

/** A wp-env project whose .wp-env.json names `port`, with no wp-env installed. */
function wpEnvProject(port) {
	const dir = project({ environment: { backend: 'wp-env' } });
	fs.writeFileSync(path.join(dir, '.wp-env.json'), JSON.stringify({ port }));
	return dir;
}

async function listenOnFreePort() {
	const listener = net.createServer();
	await new Promise((resolve) => listener.listen(0, '0.0.0.0', resolve)); // every interface, as Docker publishes
	return listener;
}

test('wp-env status without wp-env to ask: a listener it cannot vouch for is unknown, silence is not running', async () => {
	// The usual 8888 conflict: another project's containers hold the port. A
	// port probe cannot tell them from ours, so it must not claim either.
	const listener = await listenOnFreePort();
	const { port } = listener.address();
	const dir = wpEnvProject(port);
	const cwd = process.cwd();
	const PATH = process.env.PATH;
	try {
		process.chdir(dir);
		process.env.PATH = dir; // no global wp-env, and no node_modules here
		const backend = createWpEnv();
		assert.equal((await backend.status()).running, null, 'held by something wp-env did not confirm');

		await new Promise((resolve) => listener.close(resolve));
		const after = await backend.status();
		assert.equal(after.running, false, 'nothing answering is a certain no');
		assert.equal(after.port, port);
	} finally {
		process.env.PATH = PATH;
		process.chdir(cwd);
		if (listener.listening) listener.close();
		fs.removeSync(dir);
	}
});

test('server status and doctor do not count another process on the port as this project', async () => {
	const listener = await listenOnFreePort();
	const { port } = listener.address();
	const dir = wpEnvProject(port);
	// Async spawn: the listener lives in this process's event loop, which a
	// spawnSync would block.
	const run = (argv) => new Promise((resolve) => {
		const child = spawn(process.execPath, [BIN, ...argv], { cwd: dir, env: { ...process.env, WONDERPRESS_ENV: '', PATH: dir } });
		let stdout = '';
		child.stdout.on('data', (d) => { stdout += d; });
		child.on('close', (status) => resolve({ stdout, status }));
	});
	try {
		const status = onlyEnvelope((await run(['server', 'status', '--format', 'json'])).stdout);
		assert.equal(status.ok, true);
		assert.equal(status.data.running, null);
		assert.equal(status.data.port, port);

		const doctorRun = onlyEnvelope((await run(['doctor', '--format', 'json'])).stdout);
		const portCheck = doctorRun.data.checks.find((c) => c.check === 'wp-env-port');
		assert.equal(portCheck.ok, false, 'a real conflict is a failure, not "this project\'s own environment"');
		assert.equal(portCheck.hint, doctor.portInUseHint(port));
		assert.doesNotMatch(portCheck.detail, /own environment/);
	} finally {
		await new Promise((resolve) => listener.close(resolve));
		fs.removeSync(dir);
	}
});

test('an own-environment answer of "unknown" does not pass the port check', async () => {
	const busy = { ...allPresent, isPortFree: async () => false };
	const report = await doctor.run('wp-env', { platform: 'darwin', port: 8888, deps: busy, ownEnvironmentRunning: async () => null });
	assert.equal(report.checks.find((c) => c.check === 'wp-env-port').ok, false);
});

// --- doctor ---

const CHECK_KEYS = ['backend', 'check', 'detail', 'hint', 'label', 'ok', 'platform'];

const allPresent = {
	which: (bin) => `/usr/bin/${bin}`,
	exec: () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
	isPortFree: async () => true,
};

test('every check has the documented shape', async () => {
	const report = await doctor.run(null, { platform: 'darwin', port: 8888, deps: allPresent });
	assert.equal(report.ok, true);
	assert.equal(report.backend, null);
	assert.equal(report.platform, 'darwin');
	assert.deepEqual(report.checks.map((c) => c.check), ['wp-cli', 'composer', 'docker', 'docker-compose', 'docker-daemon', 'wp-env-port']);
	for (const c of report.checks) {
		assert.deepEqual(Object.keys(c).sort(), CHECK_KEYS);
		assert.ok(['host', 'wp-env', 'any'].includes(c.backend));
		assert.ok(['darwin', 'linux', 'win32', 'any'].includes(c.platform));
		assert.equal(c.hint, null, 'a passing check has no hint');
	}
});

test('the host backend on Windows is one failing check saying to use wp-env', async () => {
	const report = await doctor.run('host', { platform: 'win32', deps: allPresent });
	assert.equal(report.ok, false);
	assert.equal(report.checks.length, 1);
	const [only] = report.checks;
	assert.equal(only.check, 'host-platform');
	assert.equal(only.backend, 'host');
	assert.equal(only.platform, 'win32');
	assert.match(only.hint, /not supported on Windows/);
	assert.match(only.hint, /--env wp-env/);
});

test('every-backend mode on Windows checks wp-env only', async () => {
	const report = await doctor.run(null, { platform: 'win32', deps: allPresent });
	assert.ok(!report.checks.some((c) => c.backend === 'host'));
	assert.ok(report.checks.some((c) => c.check === 'docker'));
	assert.equal(report.ok, true);
});

test('a missing WP-CLI fails the host check with the message init has always printed', async () => {
	const report = await doctor.run('host', { platform: 'linux', deps: { ...allPresent, which: () => null } });
	assert.equal(report.ok, false);
	assert.equal(report.checks[0].check, 'wp-cli');
	assert.equal(report.checks[0].hint, doctor.HINTS.wpCli);
	assert.match(doctor.HINTS.wpCli, /^Wonderpress leans heavily on the WP CLI/);
});

test('a machine with WP-CLI but no Composer is not ready, under either backend', async () => {
	// init needs Composer for the theme's packages, and used to find it missing
	// only after the clone and npm install. doctor is the checklist that is
	// supposed to say so first.
	const onlyWp = { ...allPresent, which: (bin) => (bin === 'composer' ? null : `/usr/bin/${bin}`) };
	for (const backend of ['host', 'wp-env']) {
		const report = await doctor.run(backend, { platform: 'darwin', deps: onlyWp });
		assert.equal(report.ok, false, backend);
		const composer = report.checks.find((c) => c.check === 'composer');
		assert.equal(composer.ok, false);
		assert.equal(composer.backend, 'any');
		assert.equal(composer.hint, doctor.HINTS.composer);
		assert.match(composer.hint, /getcomposer\.org/);

		const preflight = await doctor.preflight(backend, { platform: 'darwin', deps: onlyWp });
		assert.deepEqual(preflight, { ok: false, errors: [doctor.HINTS.composer] }, 'init stops before it clones anything');
	}
});

test('doctor run with only WP-CLI on PATH fails on Composer', { skip: process.platform === 'win32' && 'a sh stub stands in for wp' }, () => {
	// End to end: PATH holds node and a stub `wp`, nothing else.
	const bin = tmp('wp-path-');
	fs.writeFileSync(path.join(bin, 'wp'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
	fs.symlinkSync(process.execPath, path.join(bin, 'node'));
	try {
		const result = spawnSync(process.execPath, [BIN, 'doctor', '--env', 'host', '--format', 'json'], {
			encoding: 'utf8',
			cwd: os.tmpdir(),
			env: { ...process.env, WONDERPRESS_ENV: '', PATH: bin },
		});
		const body = onlyEnvelope(result.stdout);
		assert.equal(body.ok, false);
		assert.equal(result.status, 1);
		const byId = Object.fromEntries(body.data.checks.map((c) => [c.check, c]));
		assert.equal(byId['wp-cli'].ok, true);
		assert.equal(byId.composer.ok, false);
	} finally {
		fs.removeSync(bin);
	}
});

test('without Docker, the Compose and daemon checks are reported but not reached', async () => {
	const report = await doctor.run('wp-env', { platform: 'darwin', deps: { ...allPresent, which: () => null } });
	const byId = Object.fromEntries(report.checks.map((c) => [c.check, c]));
	assert.equal(byId.docker.ok, false);
	assert.equal(byId['docker-compose'].ok, false);
	assert.equal(byId['docker-compose'].hint, null);
	assert.match(byId['docker-daemon'].detail, /Not checked/);

	// And preflight says what the old inline preflight said — Docker, then
	// WP-CLI, nothing about Compose or the daemon — plus Composer, which it
	// never checked.
	const preflight = await doctor.preflight('wp-env', { platform: 'darwin', deps: { ...allPresent, which: () => null } });
	assert.deepEqual(preflight, { ok: false, errors: [doctor.HINTS.docker, doctor.HINTS.wpCli, doctor.HINTS.composer] });
});

test('a dead daemon and a missing Compose plugin are separate failures', async () => {
	const exec = (cmd) => ({ code: 1, stdout: '', stderr: `${cmd} failed\nmore` });
	const preflight = await doctor.preflight('wp-env', { platform: 'linux', deps: { ...allPresent, exec } });
	assert.deepEqual(preflight.errors, [doctor.HINTS.compose, doctor.HINTS.daemon]);

	const report = await doctor.run('wp-env', { platform: 'linux', deps: { ...allPresent, exec } });
	assert.equal(report.checks.find((c) => c.check === 'docker-daemon').detail, 'docker info failed');
});

test('preflight leaves the port to provision; doctor checks it', async () => {
	const busy = { ...allPresent, isPortFree: async () => false };
	assert.equal((await doctor.preflight('wp-env', { platform: 'darwin', port: 8888, deps: busy })).ok, true);

	const report = await doctor.run('wp-env', { platform: 'darwin', port: 8888, deps: busy });
	const port = report.checks.find((c) => c.check === 'wp-env-port');
	assert.equal(port.ok, false);
	assert.equal(port.hint, doctor.portInUseHint(8888));
});

test('a port held by the project\'s own running environment passes', async () => {
	const busy = { ...allPresent, isPortFree: async () => false };
	const report = await doctor.run('wp-env', { platform: 'darwin', port: 8888, deps: busy, ownEnvironmentRunning: async () => true });
	assert.equal(report.checks.find((c) => c.check === 'wp-env-port').ok, true);
	assert.equal(report.ok, true);
});

test('doctor --format json prints one envelope with the report in data', () => {
	const result = cli(['doctor', '--env', 'host', '--format', 'json'], { cwd: os.tmpdir() });
	const body = onlyEnvelope(result.stdout);
	assert.equal(body.data.backend, 'host');
	assert.equal(body.data.platform, process.platform);
	assert.equal(body.ok, body.data.ok);
	assert.equal(result.status, body.ok ? 0 : 1);
	for (const c of body.data.checks) {
		assert.deepEqual(Object.keys(c).sort(), CHECK_KEYS);
	}
	if (!body.ok) {
		assert.equal(body.error.code, 'doctor');
	}
});

// --- manifest schema export ---

test('manifest schema --format json returns both schemas', () => {
	const result = cli(['manifest', 'schema', '--format', 'json']);
	const body = onlyEnvelope(result.stdout);
	assert.equal(result.status, 0);
	assert.equal(body.ok, true);
	assert.deepEqual(body.data, { partial: buildPartialManifestSchema(), template: buildPageTemplateManifestSchema() });
});

test('manifest schema <kind> returns that one schema', () => {
	const partial = onlyEnvelope(cli(['manifest', 'schema', 'partial', '--format', 'json']).stdout);
	assert.deepEqual(partial.data, buildPartialManifestSchema());

	const template = onlyEnvelope(cli(['manifest', 'schema', 'template', '--format', 'json']).stdout);
	assert.deepEqual(template.data, buildPageTemplateManifestSchema());
});

test('manifest schema in human mode prints the JSON itself', () => {
	const result = cli(['manifest', 'schema', 'partial']);
	assert.equal(result.status, 0);
	assert.deepEqual(JSON.parse(result.stdout), buildPartialManifestSchema());
});

test('manifest with no subcommand shows its help; an unknown one fails', () => {
	const bare = cli(['manifest']);
	assert.equal(bare.status, 0);
	assert.match(bare.stdout, /manifest schema partial/);

	const unknown = cli(['manifest', 'bogus', '--format', 'json']);
	assert.equal(unknown.status, 1);
	assert.equal(onlyEnvelope(unknown.stdout).error.code, 'unknown_command');
});

test('an unknown manifest kind is a usage error', () => {
	const result = cli(['manifest', 'schema', 'bogus', '--format', 'json']);
	const body = onlyEnvelope(result.stdout);
	assert.equal(result.status, 2);
	assert.equal(body.error.code, 'usage');
});

// --- the cliVersion pin ---

test('cliVersionMismatch is null without a root, without a pin, or when they agree', () => {
	const dir = project({ cliVersion: '1.2.3' });
	const bare = project({});
	try {
		assert.equal(config.cliVersionMismatch(null, '1.2.3'), null);
		assert.equal(config.cliVersionMismatch(bare, '1.2.3'), null);
		assert.equal(config.cliVersionMismatch(dir, '1.2.3'), null);
		assert.deepEqual(config.cliVersionMismatch(dir, '9.9.9'), { pinned: '1.2.3', current: '9.9.9' });
	} finally {
		fs.removeSync(dir);
		fs.removeSync(bare);
	}
});

function initBackend() {
	return {
		name: 'host',
		capabilities: { honorsDbFlags: true, honorsSiteHostname: true, detachedServer: false },
		async preflight() { return { ok: true, errors: [] }; },
		async prepare() { return { ok: true, errors: [] }; },
		// Fail here so init returns before installCore reaches the network; the
		// config has already been written by then.
		async provision() { return { ok: false, errors: ['stop here'] }; },
		wpCli() { return { code: 0, stdout: '[]', stderr: '' }; },
	};
}

async function runInit(rc) {
	const cwd = process.cwd();
	const exitCode = process.exitCode;
	const dir = project(rc);
	env.activate(initBackend());
	try {
		await core.init(dir, { interactive: false, yes: true });
		return config.read(dir).data;
	} finally {
		env.reset();
		process.chdir(cwd);
		process.exitCode = exitCode;
		fs.removeSync(dir);
	}
}

test('init pins the running CLI version in .wonderpressrc', async () => {
	const data = await runInit({});
	assert.equal(data.cliVersion, pkg.version);
});

test('init leaves an existing pin alone', async () => {
	const data = await runInit({ cliVersion: '0.0.1' });
	assert.equal(data.cliVersion, '0.0.1', 're-running init must not silently bump a committed pin');
});

test('a pin mismatch warns once on stderr and never on stdout', () => {
	const dir = project({ cliVersion: '0.0.1' });
	try {
		const json = cli(['version', '--dir', dir, '--format', 'json']);
		const body = onlyEnvelope(json.stdout);
		assert.deepEqual(body.data.cliVersionMismatch, { pinned: '0.0.1', current: pkg.version });
		const warning = `This project pins wonderpress-cli 0.0.1; you are running ${pkg.version}.`;
		assert.equal(json.stderr.split(warning).length - 1, 1, 'exactly one warning');

		const human = cli(['version', '--dir', dir]);
		assert.doesNotMatch(human.stdout, /pins wonderpress-cli/);
		assert.match(human.stderr, /pins wonderpress-cli 0\.0\.1/);

		// Any command, not just version.
		const status = cli(['server', 'status', '--dir', dir, '--format', 'json']);
		onlyEnvelope(status.stdout);
		assert.match(status.stderr, /pins wonderpress-cli 0\.0\.1/);
	} finally {
		fs.removeSync(dir);
	}
});

test('no warning when the pin matches, or outside a project', () => {
	const dir = project({ cliVersion: pkg.version });
	const outside = tmp();
	try {
		const matched = cli(['version', '--dir', dir, '--format', 'json']);
		assert.equal(onlyEnvelope(matched.stdout).data.cliVersionMismatch, null);
		assert.doesNotMatch(matched.stderr, /pins wonderpress-cli/);

		const away = cli(['version', '--format', 'json'], { cwd: outside });
		assert.equal(onlyEnvelope(away.stdout).data.cliVersionMismatch, null);
		assert.doesNotMatch(away.stderr, /pins wonderpress-cli/);
	} finally {
		fs.removeSync(dir);
		fs.removeSync(outside);
	}
});
