import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as core from '../src/core.js';
import * as doctor from '../src/doctor.js';
import { inspect } from '../src/core-command.js';
import { declaredConstraint, installedVersion, lockedVersion } from '../src/composer.js';
import { writeStubBin } from './helpers/stub-bin.js';

/**
 * `wonderpress core status` / `core update`: the wonderpress-core dependency
 * seen and moved from the CLI, and the `core` record in .wonderpressrc kept
 * true by it. What is pinned here is the contract the desktop app reads (the
 * envelope, one line on stdout) and the one invariant the command exists for:
 * after an update, the record says what the lock says.
 *
 * Composer itself is a stub. It rewrites composer.lock (and composer.json for
 * a `require`) the way the real one would, logs its argv, and prints to stdout
 * so the one-envelope-line rule is exercised rather than assumed.
 **/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');
const PKG = core.CORE_PACKAGE;

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-core-cmd-')));
}

/**
 * A project root with .wonderpressrc and themes. Each theme is
 * { name, constraint?, locked?, installed? }: a constraint writes composer.json
 * requiring core, `locked` writes composer.lock, `installed` writes
 * vendor/composer/installed.json.
 **/
function project({ rc = {}, themes = [] } = {}) {
	const root = tmp();
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify(rc, null, 2) + '\n');
	for (const theme of themes) {
		const dir = themeDir(root, theme.name);
		fs.ensureDirSync(dir);
		fs.writeFileSync(path.join(dir, 'style.css'), `/* Theme Name: ${theme.name} */\n`);
		if (theme.constraint) {
			fs.writeJsonSync(path.join(dir, 'composer.json'), { name: `acme/${theme.name}`, require: { [PKG]: theme.constraint } }, { spaces: 2 });
		}
		if (theme.locked) {
			fs.writeJsonSync(path.join(dir, 'composer.lock'), { packages: [{ name: PKG, version: theme.locked }] }, { spaces: 2 });
		}
		if (theme.installed) {
			fs.ensureDirSync(path.join(dir, 'vendor', 'composer'));
			fs.writeJsonSync(path.join(dir, 'vendor', 'composer', 'installed.json'), { packages: [{ name: PKG, version: theme.installed }] }, { spaces: 2 });
		}
	}
	return root;
}

function themeDir(root, name = 'wonderpress') {
	return path.join(root, 'wp-content', 'themes', name);
}

function rcOf(root) {
	return JSON.parse(fs.readFileSync(path.join(root, '.wonderpressrc'), 'utf8'));
}

/**
 * A fake `composer` on PATH. `update` rewrites the lock to STUB_NEXT_VERSION
 * (unless --dry-run); `require pkg:c` also rewrites composer.json. STUB_FAIL
 * makes it exit 1 before touching anything. Argv is appended to `log`.
 **/
function stubComposer(root, { nextVersion = '2.3.0' } = {}) {
	const bin = path.join(root, 'stub-bin');
	const log = path.join(root, 'composer-argv.log');
	writeStubBin(bin, 'composer', `
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n');
process.stdout.write('Loading composer repositories with package information\\n');
if (process.env.STUB_FAIL) {
	process.stderr.write('Your requirements could not be resolved to an installable set of packages.\\n');
	process.exit(1);
}
const dryRun = argv.includes('--dry-run');
const next = process.env.STUB_NEXT_VERSION || ${JSON.stringify(nextVersion)};
const cwd = process.cwd();
if (!dryRun) {
	if (argv[0] === 'require') {
		const [name, constraint] = argv[1].split(':');
		const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'composer.json'), 'utf8'));
		manifest.require = manifest.require || {};
		manifest.require[name] = constraint;
		fs.writeFileSync(path.join(cwd, 'composer.json'), JSON.stringify(manifest, null, 2) + '\\n');
	}
	const name = argv[0] === 'require' ? argv[1].split(':')[0] : argv[1];
	fs.writeFileSync(path.join(cwd, 'composer.lock'), JSON.stringify({ packages: [{ name, version: next }] }, null, 2) + '\\n');
	fs.mkdirSync(path.join(cwd, 'vendor', 'composer'), { recursive: true });
	fs.writeFileSync(path.join(cwd, 'vendor', 'composer', 'installed.json'), JSON.stringify({ packages: [{ name, version: next }] }, null, 2) + '\\n');
}
process.exit(0);
`);
	return { bin, log, argv: () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}

/** PATH holding only `dirs` plus this Node, so Composer is exactly the stub or nothing. */
function pathWith(...dirs) {
	return [...dirs, path.dirname(process.execPath)].join(path.delimiter);
}

function cli(argv, cwd, env = {}) {
	return spawnSync(process.execPath, [BIN, ...argv], {
		encoding: 'utf8',
		cwd,
		env: { ...process.env, WONDERPRESS_ENV: '', WONDERPRESS_CORE_REPO: '', WONDERPRESS_CORE_REF: '', ...env },
	});
}

/** stdout must be exactly one envelope line — the app's whole contract. */
function onlyEnvelope(stdout) {
	const lines = String(stdout).split('\n').filter((l) => l.trim());
	assert.equal(lines.length, 1, `expected exactly one stdout line, got:\n${stdout}`);
	return JSON.parse(lines[0]);
}

// --- the readers ------------------------------------------------------------

test('the Composer readers report null for what is not there rather than throwing', () => {
	const root = project({ themes: [{ name: 'bare' }] });
	const dir = themeDir(root, 'bare');
	assert.equal(declaredConstraint(dir, PKG), null, 'no composer.json');
	assert.equal(lockedVersion(dir, PKG), null, 'no composer.lock');
	assert.equal(installedVersion(dir, PKG), null, 'no vendor/');

	fs.writeFileSync(path.join(dir, 'composer.json'), '{ not json');
	fs.writeFileSync(path.join(dir, 'composer.lock'), '{ not json');
	assert.equal(declaredConstraint(dir, PKG), null, 'unparseable manifest');
	assert.equal(lockedVersion(dir, PKG), null, 'unparseable lock');
});

test('installedVersion reads both Composer 2 and Composer 1 layouts', () => {
	const root = project({ themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0', installed: '2.2.0' }] });
	const dir = themeDir(root);
	assert.equal(installedVersion(dir, PKG), '2.2.0', 'Composer 2: { packages: [...] }');
	fs.writeJsonSync(path.join(dir, 'vendor', 'composer', 'installed.json'), [{ name: PKG, version: '2.1.0' }]);
	assert.equal(installedVersion(dir, PKG), '2.1.0', 'Composer 1: a bare array');
});

test('inspect() agrees when every source agrees, and ignores a missing one', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0', installed: '2.2.0' }] });
	assert.deepEqual(inspect(root, themeDir(root)), {
		package: PKG, constraint: '^2.0', locked: '2.2.0', installed: '2.2.0', recorded: '2.2.0', inSync: true,
	});

	// No vendor/ yet is not a disagreement; it is reported as null.
	const fresh = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const state = inspect(fresh, themeDir(fresh));
	assert.equal(state.installed, null);
	assert.equal(state.inSync, true);
});

// --- core status ------------------------------------------------------------

test('status --format json is one envelope with the four sources and the verdict', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0', installed: '2.2.0' }] });
	const result = cli(['core', 'status', '--format', 'json'], root);
	assert.equal(result.status, 0, result.stderr);
	const env = onlyEnvelope(result.stdout);
	assert.equal(env.ok, true);
	assert.deepEqual(env.data, {
		theme: 'wonderpress', package: PKG, constraint: '^2.0', locked: '2.2.0', installed: '2.2.0', recorded: '2.2.0', inSync: true,
	});
});

test('bare `core` is `core status`', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const env = onlyEnvelope(cli(['core', '--format', 'json'], root).stdout);
	assert.equal(env.ok, true);
	assert.equal(env.data.locked, '2.2.0');
});

test('status names a record that drifted from the lock, and how to repair it', () => {
	// The case the command exists for: `composer update` ran in the theme and
	// nothing rewrote .wonderpressrc.
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.3.0', installed: '2.3.0' }] });

	const json = onlyEnvelope(cli(['core', 'status', '--format', 'json'], root).stdout);
	assert.equal(json.data.inSync, false);
	assert.equal(json.data.recorded, '2.2.0');
	assert.equal(json.data.locked, '2.3.0');

	const human = cli(['core', 'status'], root);
	assert.equal(human.status, 0, 'status reports; it does not fail');
	const out = human.stdout + human.stderr;
	assert.match(out, /records 2\.2\.0 but composer\.lock resolves 2\.3\.0/);
	assert.match(out, /wonderpress core update/);
});

test('status names a vendor\\/ that lags the lock, with the Composer fix', () => {
	const root = project({ rc: { core: '2.3.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.3.0', installed: '2.2.0' }] });
	const human = cli(['core', 'status'], root);
	assert.match(human.stdout + human.stderr, /vendor\/ holds 2\.2\.0 but composer\.lock resolves 2\.3\.0/);
	assert.match(human.stdout + human.stderr, /composer install/);
	assert.equal(onlyEnvelope(cli(['core', 'status', '--format', 'json'], root).stdout).data.inSync, false);
});

test('status says when everything agrees', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0', installed: '2.2.0' }] });
	const human = cli(['core', 'status'], root);
	assert.match(human.stdout + human.stderr, /Everything agrees on 2\.2\.0/);
});

// --- which theme ------------------------------------------------------------

test('only themes that require core are candidates', () => {
	const none = project({ themes: [{ name: 'plain' }] });
	let env = onlyEnvelope(cli(['core', 'status', '--format', 'json'], none).stdout);
	assert.equal(env.ok, false);
	assert.equal(env.error.code, 'no_core');
	assert.match(env.error.hint, /plain/);

	const several = project({ themes: [
		{ name: 'parent', constraint: '^2.0', locked: '2.2.0' },
		{ name: 'child', constraint: '^2.0', locked: '2.2.0' },
		{ name: 'plain' },
	] });
	env = onlyEnvelope(cli(['core', 'status', '--format', 'json'], several).stdout);
	assert.equal(env.error.code, 'ambiguous_theme');
	assert.match(env.error.hint, /child, parent/, 'names the candidates, not the plain theme');

	env = onlyEnvelope(cli(['core', 'status', '--theme', 'child', '--format', 'json'], several).stdout);
	assert.equal(env.ok, true);
	assert.equal(env.data.theme, 'child');

	env = onlyEnvelope(cli(['core', 'status', '--theme', 'plain', '--format', 'json'], several).stdout);
	assert.equal(env.error.code, 'core_not_declared', 'a real theme without core is a different error from a typo');

	env = onlyEnvelope(cli(['core', 'status', '--theme', 'nope', '--format', 'json'], several).stdout);
	assert.equal(env.error.code, 'theme_not_found');
});

test('outside a project, core says so', () => {
	const nowhere = tmp();
	const env = onlyEnvelope(cli(['core', 'status', '--format', 'json'], nowhere).stdout);
	assert.equal(env.ok, false);
	assert.equal(env.error.code, 'env');
});

test('an unknown subcommand names it, shows the screen, and exits non-zero', () => {
	const root = project({ themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const result = cli(['core', 'bogus'], root);
	assert.match(result.stdout + result.stderr, /Unknown core subcommand: bogus/);
	assert.match(result.stdout + result.stderr, /core update/);
	assert.equal(result.status, 1);
});

// --- core update ------------------------------------------------------------

test('update runs composer update for the package and re-records what the lock resolved', () => {
	const root = project({ rc: { core: '2.2.0', cliVersion: '9.9.9' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0', installed: '2.2.0' }] });
	const composer = stubComposer(root, { nextVersion: '2.3.0' });

	const result = cli(['core', 'update', '--format', 'json'], root, { PATH: pathWith(composer.bin) });
	assert.equal(result.status, 0, result.stderr);
	const env = onlyEnvelope(result.stdout);
	assert.equal(env.ok, true);

	assert.deepEqual(composer.argv(), [['update', PKG, '--no-interaction']], 'exactly one Composer call, scoped to the package');
	assert.deepEqual(env.data.command, ['composer', 'update', PKG, '--no-interaction']);
	assert.equal(env.data.theme, 'wonderpress');
	assert.equal(env.data.changed, true);
	assert.equal(env.data.recorded, true);
	assert.equal(env.data.dryRun, false);
	assert.equal(env.data.before.locked, '2.2.0');
	assert.equal(env.data.after.locked, '2.3.0');
	assert.equal(env.data.after.recorded, '2.3.0');
	assert.equal(env.data.after.inSync, true);

	// The invariant: the record says what the lock says, and nothing else in
	// the file was touched.
	assert.equal(rcOf(root).core, '2.3.0');
	assert.equal(rcOf(root).cliVersion, '9.9.9');
	assert.equal(lockedVersion(themeDir(root), PKG), '2.3.0');
});

test('update runs Composer in the theme directory, not the project root', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const composer = stubComposer(root);
	// The stub writes the lock into its cwd; the theme's lock moving is the proof.
	cli(['core', 'update', '--format', 'json'], root, { PATH: pathWith(composer.bin) });
	assert.equal(lockedVersion(themeDir(root), PKG), '2.3.0');
	assert.equal(fs.existsSync(path.join(root, 'composer.lock')), false, 'nothing was written at the root');
});

test('update <constraint> goes through composer require, which rewrites composer.json', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0', installed: '2.2.0' }] });
	const composer = stubComposer(root, { nextVersion: '3.0.0' });

	const env = onlyEnvelope(cli(['core', 'update', '^3.0', '--format', 'json'], root, { PATH: pathWith(composer.bin) }).stdout);
	assert.equal(env.ok, true, JSON.stringify(env.error));
	assert.deepEqual(composer.argv(), [['require', `${PKG}:^3.0`, '--no-interaction']]);
	assert.equal(env.data.before.constraint, '^2.0');
	assert.equal(env.data.after.constraint, '^3.0');
	assert.equal(env.data.after.locked, '3.0.0');
	assert.equal(rcOf(root).core, '3.0.0');
	assert.equal(declaredConstraint(themeDir(root), PKG), '^3.0');
});

test('update refuses a constraint that is really a flag', () => {
	const root = project({ themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const composer = stubComposer(root);
	const result = cli(['core', 'update', '--bogus', '--format', 'json'], root, { PATH: pathWith(composer.bin) });
	const env = onlyEnvelope(result.stdout);
	assert.equal(env.error.code, 'usage');
	assert.equal(result.status, 2);
	assert.equal(fs.existsSync(path.join(root, 'composer-argv.log')), false, 'Composer never ran');
});

test('update --dry-run passes the flag through and records nothing', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const composer = stubComposer(root, { nextVersion: '2.3.0' });

	const env = onlyEnvelope(cli(['core', 'update', '--dry-run', '--format', 'json'], root, { PATH: pathWith(composer.bin) }).stdout);
	assert.equal(env.ok, true);
	assert.deepEqual(composer.argv(), [['update', PKG, '--no-interaction', '--dry-run']]);
	assert.equal(env.data.dryRun, true);
	assert.equal(env.data.recorded, false);
	assert.equal(env.data.changed, false, 'the stub honours --dry-run, so the lock did not move');
	assert.equal(rcOf(root).core, '2.2.0');
});

test('a no-op update still repairs a drifted record', () => {
	// composer update ran by hand at some point; the lock is at 2.3.0 and the
	// record still says 2.2.0. Running the command with nothing to update is
	// the documented repair.
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.3.0', installed: '2.3.0' }] });
	const composer = stubComposer(root, { nextVersion: '2.3.0' });

	const result = cli(['core', 'update'], root, { PATH: pathWith(composer.bin) });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout + result.stderr, /already at 2\.3\.0/);
	assert.match(result.stdout + result.stderr, /Recorded 2\.3\.0 in \.wonderpressrc/);
	assert.equal(rcOf(root).core, '2.3.0');
});

test('a failed Composer run records nothing and says so', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const composer = stubComposer(root);

	const result = cli(['core', 'update', '--format', 'json'], root, { PATH: pathWith(composer.bin), STUB_FAIL: '1' });
	assert.equal(result.status, 1);
	const env = onlyEnvelope(result.stdout);
	assert.equal(env.ok, false);
	assert.equal(env.error.code, 'composer');
	assert.equal(env.data.before.locked, '2.2.0', 'the state before is in the envelope so the app can show it');
	assert.equal(rcOf(root).core, '2.2.0');
	assert.equal(lockedVersion(themeDir(root), PKG), '2.2.0');
	// Composer's own complaint reached stderr, never stdout.
	assert.match(result.stderr, /could not be resolved/);
});

test('update without Composer on PATH fails before touching anything', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const empty = path.join(root, 'empty-bin');
	fs.ensureDirSync(empty);
	const env = onlyEnvelope(cli(['core', 'update', '--format', 'json'], root, { PATH: pathWith(empty) }).stdout);
	assert.equal(env.ok, false);
	assert.equal(env.error.code, 'composer_missing');
	assert.equal(env.error.hint, doctor.HINTS.composer, 'the same sentence doctor and init print');
	assert.equal(rcOf(root).core, '2.2.0');
});

test('update human output says what moved, that it was recorded, and what to commit', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const composer = stubComposer(root, { nextVersion: '2.3.0' });
	const result = cli(['core', 'update'], root, { PATH: pathWith(composer.bin) });
	assert.equal(result.status, 0, result.stderr);
	const out = result.stdout + result.stderr;
	assert.match(out, /2\.2\.0 → 2\.3\.0 in wonderpress/);
	assert.match(out, /Recorded 2\.3\.0 in \.wonderpressrc/);
	assert.match(out, /Commit composer\.json, composer\.lock, vendor\/ and \.wonderpressrc together/);
});

test('an override warns during update exactly as it does during init, and is not re-applied', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	const composer = stubComposer(root);
	// Human mode: in JSON mode warnings are quiet by convention, as every
	// other command's are.
	const result = cli(['core', 'update'], root, { PATH: pathWith(composer.bin), WONDERPRESS_CORE_REF: 'dev-my-branch' });
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout + result.stderr, /NOT be reproducible/, 'the init warning');
	assert.deepEqual(composer.argv(), [['update', PKG, '--no-interaction']], 'no composer config / require from the override');
});

// --- doctor -----------------------------------------------------------------

test('doctor compares the record with the lock inside a project', () => {
	const themes = (root) => path.join(root, 'wp-content', 'themes');

	const agree = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.2.0' }] });
	let row = doctor.coreRecordCheck(agree, PKG, themes(agree));
	assert.equal(row.check, 'core-record');
	assert.equal(row.ok, true);
	assert.equal(row.hint, null);

	const drifted = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.3.0' }] });
	row = doctor.coreRecordCheck(drifted, PKG, themes(drifted));
	assert.equal(row.ok, false);
	assert.match(row.hint, /records 2\.2\.0, but composer\.lock resolves 2\.3\.0 \(wonderpress\)/);
	assert.match(row.hint, /wonderpress core update/);

	const unrecorded = project({ themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.3.0' }] });
	row = doctor.coreRecordCheck(unrecorded, PKG, themes(unrecorded));
	assert.equal(row.ok, false, 'a project built before the record existed is told how to get one');
	assert.match(row.hint, /records no core version/);

	const unlocked = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0' }] });
	row = doctor.coreRecordCheck(unlocked, PKG, themes(unlocked));
	assert.equal(row.ok, false);
	assert.match(row.hint, /composer\.lock does not resolve/);
	assert.match(row.hint, /composer install/);

	const none = project({ themes: [{ name: 'plain' }] });
	row = doctor.coreRecordCheck(none, PKG, themes(none));
	assert.equal(row.ok, true, 'a project whose theme does not use core has nothing to compare');
	assert.match(row.detail, /No theme requires/);
});

test('doctor --format json carries the core-record row inside a project and not outside', () => {
	const root = project({ rc: { core: '2.2.0' }, themes: [{ name: 'wonderpress', constraint: '^2.0', locked: '2.3.0' }] });
	let env = onlyEnvelope(cli(['doctor', '--format', 'json'], root).stdout);
	const row = env.data.checks.find((c) => c.check === 'core-record');
	assert.ok(row, 'the row is there');
	assert.equal(row.ok, false);
	assert.equal(env.ok, false, 'a drifted record fails doctor');

	env = onlyEnvelope(cli(['doctor', '--format', 'json'], tmp()).stdout);
	assert.equal(env.data.checks.some((c) => c.check === 'core-record'), false, 'outside a project there is no record to check');
});

// --- the version pin guard, extended ---------------------------------------

test('core update names the package without restating a version anywhere', () => {
	// The same rule tests/init-orchestration.test.js pins for init: one
	// constraint in one place (the theme's composer.json).
	const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'core-command.js'), 'utf8');
	assert.doesNotMatch(source, /wonderpress-core['":]/, 'the package is named through core.CORE_PACKAGE only');
	assert.doesNotMatch(source, /['"]\^?\d+\.\d+(\.\d+)?['"]/, 'no version literal');
});
