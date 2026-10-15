import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as core from '../src/core.js';
import * as env from '../src/env/index.js';
import * as format from '../src/format.js';
import { STEPS, createReporter } from '../src/init-progress.js';
import pkg from '../package.json' with { type: 'json' };

/**
 * `init --yes --format json`: the progress protocol the desktop app's build
 * screen reads (ARCHITECTURE.md, "App-facing commands and the version pin").
 *
 * stdout is newline-delimited JSON — step events, then one envelope — and
 * every human line goes to stderr. Driven by the same kind of recording fake
 * backend as init-orchestration.test.js, in a fixture that already has a
 * `.wonderpressrc`, so the scaffold and assets steps finish at once and
 * nothing reaches the network.
 **/

const STEP_IDS = STEPS.map((step) => step.id);

function fakeBackend(overrides = {}) {
	const calls = [];
	return {
		calls,
		name: 'fake',
		capabilities: { honorsDbFlags: true, honorsSiteHostname: true, detachedServer: true },
		siteUrl() { return 'http://localhost:9999'; },
		adminLogin() { return { user: 'admin', password: null, note: null }; },
		async preflight() { calls.push('preflight'); return overrides.preflight ?? { ok: true, errors: [] }; },
		async prepare() { calls.push('prepare'); return overrides.prepare ?? { ok: true, errors: [] }; },
		async provision() { calls.push('provision'); return overrides.provision ?? { ok: true, errors: [] }; },
		wpCli(cmd) {
			const line = Array.isArray(cmd) ? cmd.join(' ') : cmd;
			calls.push(`wpCli:${line}`);
			if (line.startsWith('theme list')) {
				return { code: 0, stdout: JSON.stringify(overrides.themes ?? []), stderr: '' };
			}
			return { code: 0, stdout: '', stderr: '' };
		},
	};
}

function fixture(rc = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-init-json-')));
	fs.writeFileSync(path.join(dir, '.wonderpressrc'), JSON.stringify(rc));
	return dir;
}

/**
 * Run init in JSON mode in-process, collecting stdout lines (console.log,
 * where the reporter and format.* write) and stderr separately.
 **/
async function initJson(backend, initConfig, { rc = {}, keep = false, target = (dir) => dir } = {}) {
	const cwd = process.cwd();
	const exitCode = process.exitCode;
	const dir = fixture(rc);
	const stdout = [];
	const stderr = [];
	const originalLog = console.log;
	const realStdoutWrite = process.stdout.write;
	const realStderrWrite = process.stderr.write;
	format.configure({ '--format': 'json' });
	format.setLogsToStderr(true);
	// Keep the mode, drop the stdout guard: the test runner reports over this
	// process's stdout.
	process.stdout.write = realStdoutWrite;
	console.log = (line) => stdout.push(String(line));
	process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
	env.activate(backend);
	try {
		process.exitCode = 0;
		const result = await core.init(target(dir), { interactive: false, yes: true, wp: {}, db: {}, ...initConfig });
		return { result, dir, stdout, stderr: stderr.join(''), exitCode: process.exitCode, json: stdout.map((l) => JSON.parse(l)) };
	} finally {
		console.log = originalLog;
		process.stderr.write = realStderrWrite;
		format.reset();
		env.reset();
		process.chdir(cwd);
		process.exitCode = exitCode;
		if (!keep) {
			fs.removeSync(dir);
		}
	}
}

test('a successful run: two events per step, in order, then one envelope', async () => {
	const { result, dir, json, stderr, exitCode } = await initJson(fakeBackend(), { namespace: 'acme' });

	assert.equal(result, true);
	assert.equal(exitCode, 0);

	const events = json.slice(0, -1);
	const envelope = json[json.length - 1];

	assert.deepEqual(events.map((e) => `${e.id}:${e.state}`), STEP_IDS.flatMap((id) => [`${id}:running`, `${id}:done`]));
	for (const event of events) {
		assert.equal(event.event, 'step');
		if (event.state === 'running') {
			assert.equal(typeof event.label, 'string', 'a running event carries the label');
		} else {
			assert.equal(event.label, undefined, 'only the running event carries the label');
		}
	}
	assert.equal(events[0].label, 'Clone the environment scaffold');

	assert.equal(envelope.ok, true);
	assert.equal(envelope.error, null);
	assert.equal(envelope.data.root, dir);
	assert.equal(envelope.data.backend, 'fake');
	assert.equal(envelope.data.namespace, 'acme');
	assert.equal(envelope.data.cliVersion, pkg.version);
	assert.equal(envelope.data.url, 'http://localhost:9999');
	assert.equal(envelope.data.theme, null, 'the fixture has no theme to activate');
	assert.deepEqual(envelope.data.steps.map((s) => [s.id, s.state]), STEP_IDS.map((id) => [id, 'done']));
	for (const step of envelope.data.steps) {
		assert.equal(typeof step.ms, 'number');
	}

	// The human lines are not lost, they are the console tail.
	assert.match(stderr, /The Wonderpress environment has been initialized!/);
	assert.match(stderr, /http:\/\/localhost:9999/);
});

test('a failing provision fails the wordpress step, runs nothing after it, and the envelope says so', async () => {
	const backend = fakeBackend({ provision: { ok: false, errors: ['Port 8888 is in use.\n  lsof -nP -iTCP:8888 -sTCP:LISTEN'] } });
	const { result, json, exitCode } = await initJson(backend);

	assert.equal(result, false);
	assert.equal(exitCode, 1);

	const events = json.slice(0, -1);
	const envelope = json[json.length - 1];

	assert.deepEqual(events.map((e) => `${e.id}:${e.state}`), [
		'scaffold:running', 'scaffold:done',
		'assets:running', 'assets:done',
		'wordpress:running', 'wordpress:failed',
	]);
	const failed = events[events.length - 1];
	assert.deepEqual(failed.error, { code: 'provision', message: 'Port 8888 is in use.', hint: 'lsof -nP -iTCP:8888 -sTCP:LISTEN' });

	assert.equal(envelope.ok, false);
	assert.deepEqual(envelope.error, failed.error);
	assert.deepEqual(envelope.data.steps.map((s) => s.state), ['done', 'done', 'failed', 'queued', 'queued']);
	assert.equal(envelope.data.url, null);
	assert.deepEqual(backend.calls, ['preflight', 'prepare', 'provision']);
});

test('a failing preflight is no step: just the envelope, code preflight', async () => {
	const backend = fakeBackend({ preflight: { ok: false, errors: ['Docker is not installed.'] } });
	const { result, json, exitCode } = await initJson(backend);

	assert.equal(result, false);
	assert.equal(exitCode, 1);
	assert.equal(json.length, 1, 'no step events');
	assert.equal(json[0].ok, false);
	assert.equal(json[0].error.code, 'preflight');
	assert.match(json[0].error.message, /1 prerequisite check failed/);
	assert.equal(json[0].error.hint, 'Docker is not installed.');
	assert.deepEqual(backend.calls, ['preflight']);
});

test('--format json without --yes is a usage error, before anything runs', async () => {
	const backend = fakeBackend();
	const { result, json, exitCode } = await initJson(backend, { interactive: true, yes: false });

	assert.equal(result, false);
	assert.equal(exitCode, format.EXIT_USAGE);
	assert.equal(json.length, 1);
	assert.equal(json[0].error.code, 'usage');
	assert.match(json[0].error.hint, /--yes/);
	assert.deepEqual(backend.calls, []);
});

test('several themes and no --theme: the theme step fails with a usage error naming the flag', async () => {
	const backend = fakeBackend({ themes: [{ name: 'one' }, { name: 'two' }] });
	const { json } = await initJson(backend);

	const envelope = json[json.length - 1];
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, 'usage');
	assert.match(envelope.error.message, /one, two/);
	assert.match(envelope.error.hint, /--theme <name>/);
	assert.equal(envelope.data.steps.find((s) => s.id === 'theme').state, 'failed');
	assert.ok(!backend.calls.some((c) => c.startsWith('wpCli:theme activate')));
});

test('--theme activates that theme and names it in the envelope', async () => {
	const backend = fakeBackend({ themes: [{ name: 'one' }, { name: 'two' }] });
	const { json } = await initJson(backend, { theme: 'two' });

	const envelope = json[json.length - 1];
	assert.equal(envelope.ok, true);
	assert.equal(envelope.data.theme, 'two');
	assert.ok(backend.calls.includes('wpCli:theme activate two'));
});

test('--yes --format json never prompts, whatever init would have asked', async () => {
	// Every question init can reach with an existing scaffold: several themes
	// (answered by --theme) and a README (--readme, with no title to name it
	// by). The clean-slate confirmation is skipped by --yes; see
	// init-orchestration.test.js.
	const original = inquirer.prompt;
	inquirer.prompt = () => { throw new Error('init prompted under --yes --format json'); };
	try {
		const backend = fakeBackend({ themes: [{ name: 'one' }, { name: 'two' }] });
		const { json, dir } = await initJson(backend, { theme: 'one', readme: true }, { keep: true });
		try {
			assert.equal(json[json.length - 1].ok, true, JSON.stringify(json[json.length - 1]));
			assert.ok(fs.existsSync(path.join(dir, 'README.md')), 'the README was written without the wizard');
		} finally {
			fs.removeSync(dir);
		}
	} finally {
		inquirer.prompt = original;
	}
});

test('human mode prints no protocol lines', async () => {
	const cwd = process.cwd();
	const exitCode = process.exitCode;
	const dir = fixture();
	const printed = [];
	const original = console.log;
	console.log = (line) => printed.push(String(line));
	env.activate(fakeBackend());
	try {
		assert.equal(await core.init(dir, { interactive: false, yes: true, wp: {}, db: {} }), true);
	} finally {
		console.log = original;
		env.reset();
		process.chdir(cwd);
		process.exitCode = exitCode;
		fs.removeSync(dir);
	}
	assert.ok(printed.some((l) => /initialized!/.test(l)), 'the human lines are on stdout, as always');
	assert.ok(!printed.some((l) => l.trimStart().startsWith('{')), 'and nothing else is');
});

test('a throw outside every step (a --dir that cannot be created) still ends in one envelope', async () => {
	const backend = fakeBackend();
	const { result, stdout, stderr, exitCode, json } = await initJson(backend, {}, {
		target: (dir) => path.join(dir, '.wonderpressrc', 'site'),
	});
	assert.equal(result, false);
	assert.equal(exitCode, format.EXIT_FAIL);
	assert.equal(stdout.length, 1, `exactly one line on stdout, the envelope:\n${stdout.join('\n')}`);
	assert.equal(json[0].ok, false);
	assert.equal(json[0].error.code, 'init');
	assert.match(json[0].error.message, /ENOTDIR|EEXIST/);
	assert.deepEqual(json[0].data.steps.map((s) => s.state), ['queued', 'queued', 'queued', 'queued', 'queued']);
	assert.match(stderr, /ENOTDIR|EEXIST/, 'and the console tail says why');
});

test('human mode: a step that throws still throws, message and all, as before the reporter', async () => {
	const cwd = process.cwd();
	const exitCode = process.exitCode;
	const dir = fixture();
	const original = console.log;
	console.log = () => {};
	env.activate(fakeBackend({ provision: null }));
	env.getCurrent().provision = async () => { throw new Error('KABOOM provision'); };
	try {
		await assert.rejects(core.init(dir, { interactive: false, yes: true, wp: {}, db: {} }), /KABOOM provision/);
	} finally {
		console.log = original;
		env.reset();
		process.chdir(cwd);
		process.exitCode = exitCode;
		fs.removeSync(dir);
	}
});

test('JSON mode: a step that throws says so on stderr as well as in the envelope', async () => {
	const backend = fakeBackend();
	backend.provision = async () => { throw new Error('KABOOM provision'); };
	const { stderr, json } = await initJson(backend, {});
	const envelope = json[json.length - 1];
	assert.equal(envelope.error.code, 'wordpress');
	assert.equal(envelope.error.message, 'KABOOM provision');
	assert.match(stderr, /KABOOM provision/);
});

test('the reporter: a thrown step fails with the step id as its code', async () => {
	const lines = [];
	const reporter = createReporter({ json: true, write: (line, cb) => { lines.push(JSON.parse(line)); cb && cb(); } });
	const exitCode = process.exitCode;
	try {
		assert.equal(await reporter.step('scaffold', async () => { throw new Error('boom'); }), false);
	} finally {
		process.exitCode = exitCode;
	}
	assert.deepEqual(lines[1], { event: 'step', id: 'scaffold', state: 'failed', error: { code: 'scaffold', message: 'boom', hint: null } });
	assert.equal(lines[2].error.message, 'boom');
});

// --- cancel ---
//
// The app stops a build by signalling init. A spawned init sleeps inside a fake
// provision that is waiting on a real child process; SIGTERM must stop the
// child, fail the step with `cancelled`, print the envelope, exit non-zero, and
// leave the folder exactly as it was. POSIX only: Windows has no SIGTERM to
// catch (process.kill there is TerminateProcess).

const src = (file) => JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', 'src', file)).href);

test('SIGTERM mid-step: the child is stopped, the envelope says cancelled, the folder stays', { skip: process.platform === 'win32' }, async () => {
	const dir = fixture({ namespace: 'acme' });
	const pidFile = path.join(os.tmpdir(), `wp-init-cancel-${process.pid}-${Date.now()}.pid`);

	const script = `
		import * as core from ${src('core.js')};
		import * as env from ${src('env/index.js')};
		import * as format from ${src('format.js')};
		import { runAsync } from ${src('proc.js')};
		format.configure({ '--format': 'json' });
		format.setLogsToStderr(true);
		env.activate({
			name: 'fake',
			capabilities: {},
			async preflight() { return { ok: true, errors: [] }; },
			async prepare() { return { ok: true, errors: [] }; },
			async provision() {
				const child = await runAsync(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", ${JSON.stringify(pidFile)}]);
				return { ok: child.code === 0, errors: ['the child ended'] };
			},
			wpCli() { return { code: 0, stdout: '[]', stderr: '' }; },
		});
		await core.init(${JSON.stringify(dir)}, { interactive: false, yes: true, wp: {}, db: {} });
	`;

	const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
	let stdout = '';
	let stderr = '';
	child.stdout.on('data', (chunk) => { stdout += chunk; });
	child.stderr.on('data', (chunk) => { stderr += chunk; });
	const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

	try {
		// Wait for the grandchild to be running inside the wordpress step.
		const deadline = Date.now() + 20000;
		while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8')) {
			assert.ok(Date.now() < deadline, `the fake step never started.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));

		child.kill('SIGTERM');
		const { code } = await exited;

		assert.equal(code, 143, `init exits non-zero on SIGTERM.\nstderr:\n${stderr}`);

		const lines = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
		const envelope = lines[lines.length - 1];
		assert.deepEqual(lines.slice(0, -1).map((e) => `${e.id}:${e.state}`), [
			'scaffold:running', 'scaffold:done',
			'assets:running', 'assets:done',
			'wordpress:running', 'wordpress:failed',
		]);
		assert.equal(lines[lines.length - 2].error.code, 'cancelled');
		assert.equal(envelope.ok, false);
		assert.equal(envelope.error.code, 'cancelled');
		assert.equal(envelope.data.root, dir);
		assert.deepEqual(envelope.data.steps.map((s) => s.state), ['done', 'done', 'failed', 'queued', 'queued']);

		// The running child was stopped with it.
		const deadlineGone = Date.now() + 5000;
		let alive = true;
		while (alive && Date.now() < deadlineGone) {
			try {
				process.kill(grandchild, 0);
				await new Promise((resolve) => setTimeout(resolve, 50));
			} catch {
				alive = false;
			}
		}
		assert.equal(alive, false, 'the step\'s child process was stopped');

		// Nothing was deleted.
		assert.ok(fs.existsSync(path.join(dir, '.wonderpressrc')));
		assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.wonderpressrc'), 'utf8')).namespace, 'acme');
	} finally {
		child.kill('SIGKILL');
		fs.removeSync(dir);
		fs.removeSync(pidFile);
	}
});

test('through the binary: --format json without --yes is one envelope on stdout and the reason on stderr', async () => {
	const { spawnSync } = await import('node:child_process');
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-init-json-bin-')));
	try {
		const bin = path.join(import.meta.dirname, '..', 'bin', 'wonderpress.js');
		const out = spawnSync(process.execPath, [bin, 'init', '--format', 'json', '--dir', dir], { encoding: 'utf8', env: { ...process.env, WONDERPRESS_ENV: '' } });
		const lines = out.stdout.split('\n').filter(Boolean);
		assert.equal(lines.length, 1, out.stdout);
		const envelope = JSON.parse(lines[0]);
		assert.equal(envelope.ok, false);
		assert.equal(envelope.error.code, 'usage');
		assert.equal(out.status, format.EXIT_USAGE);
		assert.match(out.stderr, /needs --yes/);
		assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written');
	} finally {
		fs.removeSync(dir);
	}
});

// A cancel while --clean-slate tears the old environment down. The real wp-env
// teardown is `wp-env destroy` through spawnSync, which holds the process: the
// signal is only handled once it returns, with no step running. Either way the
// folder must survive: a cancel never deletes anything.
for (const mode of ['sync', 'async']) {
	test(`SIGTERM during the --clean-slate teardown (${mode} child): cancelled, and nothing is wiped`, { skip: process.platform === 'win32' }, async () => {
		const dir = fixture({ namespace: 'acme' });
		fs.writeFileSync(path.join(dir, 'precious.txt'), 'keep me');
		const marker = path.join(os.tmpdir(), `wp-init-teardown-${process.pid}-${Date.now()}-${mode}`);

		const destroy = mode === 'sync'
			? `async destroy() {
				require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');
				spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 1500)']);
				return { ok: true, errors: [] };
			}`
			: `async destroy() {
				require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');
				const child = await runAsync(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
				return { ok: child.code === 0, errors: ['the teardown was stopped'] };
			}`;

		const script = `
			import { createRequire } from 'node:module';
			import { spawnSync } from 'node:child_process';
			import * as core from ${src('core.js')};
			import * as env from ${src('env/index.js')};
			import * as format from ${src('format.js')};
			import { runAsync } from ${src('proc.js')};
			const require = createRequire(import.meta.url);
			format.configure({ '--format': 'json' });
			format.setLogsToStderr(true);
			env.activate({
				name: 'fake',
				capabilities: {},
				async preflight() { return { ok: true, errors: [] }; },
				${destroy},
				async prepare() { return { ok: true, errors: [] }; },
				async provision() { return { ok: true, errors: [] }; },
				wpCli() { return { code: 0, stdout: '[]', stderr: '' }; },
			});
			await core.init(${JSON.stringify(dir)}, { interactive: false, yes: true, cleanSlate: true, wp: {}, db: {} });
		`;

		const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

		try {
			const deadline = Date.now() + 20000;
			while (!fs.existsSync(marker)) {
				assert.ok(Date.now() < deadline, `the teardown never started.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			await new Promise((resolve) => setTimeout(resolve, 200));
			child.kill('SIGTERM');
			const { code } = await exited;

			assert.equal(code, 143, `init exits non-zero on SIGTERM.\nstderr:\n${stderr}`);
			const lines = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l));
			assert.equal(lines.length, 1, `no step had started: just the envelope.\n${stdout}`);
			assert.equal(lines[0].ok, false);
			assert.equal(lines[0].error.code, 'cancelled');
			assert.doesNotMatch(stderr, /clean slate/i, 'the wipe never began');

			assert.equal(fs.readFileSync(path.join(dir, 'precious.txt'), 'utf8'), 'keep me');
			assert.ok(fs.existsSync(path.join(dir, '.wonderpressrc')));
		} finally {
			child.kill('SIGKILL');
			fs.removeSync(dir);
			fs.removeSync(marker);
		}
	});
}
