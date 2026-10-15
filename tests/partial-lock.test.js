import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
	SyncConflictError,
	paramsFromFlags,
	removePartial,
	syncPartialFromManifest,
	writePartial,
} from '../src/partial.js';
import { addBlock } from '../src/block.js';
import { checkPartialDrift } from '../src/partial-drift.js';
import { FENCE_CLOSE, FENCE_OPEN, extractFencedRegion } from '../src/partial-class.js';
import { contentHash, partialLockPath, sha256 } from '../src/partial-lock.js';
import { command as lintCommand, inspectTheme } from '../src/lint.js';
import { handlers } from '../src/mcp.js';
import { parseEnvelope } from '../src/format.js';
import pkg from '../package.json' with { type: 'json' };
import { writeStubBin } from './helpers/stub-bin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

const MANIFEST = '.wonderpress/manifest/partials/hero.json';
const LOCK = '.wonderpress/lock/partials/hero.json';
const CLASS = 'src/partials/class-hero.php';
const BLOCK = 'blocks/hero/block.json';

const USER_METHOD = `
	public function variant_class() {
		return 'hero--wide';
	}
`;

// Stable theme basename inside a random parent: the block namespace derives
// from it (same reason as partial.test.js).
function tmpTheme() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lock-')), 'wonderpress');
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

async function createHero(dir, extra = {}) {
	await writePartial(paramsFromFlags({ '--name': 'Hero', '--prop': ['title:string:required'], '--no-style': true, ...extra }), dir);
	return readManifest(dir);
}

const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
const readLock = (dir) => JSON.parse(fs.readFileSync(path.join(dir, LOCK), 'utf8'));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const write = (dir, rel, text) => fs.writeFileSync(path.join(dir, rel), text);

function addProp(dir, manifest, name) {
	manifest.properties.push({ name, type: 'string', required: false, description: '' });
	write(dir, MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
	return readManifest(dir);
}

// An edit inside the fence: flip the generated `required` flag.
function editFence(dir) {
	write(dir, CLASS, read(dir, CLASS).replace("'required'    => true", "'required'    => false"));
}

function editBlock(dir) {
	const block = JSON.parse(read(dir, BLOCK));
	block.title = 'Hand-edited title';
	write(dir, BLOCK, JSON.stringify(block, null, 2) + '\n');
}

function withTheme(fn) {
	return async () => {
		const dir = tmpTheme();
		try {
			await fn(dir);
		} finally {
			fs.removeSync(path.dirname(dir));
		}
	};
}

test('create writes a per-partial lock of the manifest, fenced region, and block.json', withTheme(async (dir) => {
	await createHero(dir, { '--block': true });
	const lock = readLock(dir);
	assert.deepEqual(Object.keys(lock), ['manifest', 'classFence', 'block', 'cliVersion']);
	assert.equal(lock.manifest, sha256(fs.readFileSync(path.join(dir, MANIFEST))));
	assert.equal(lock.classFence, sha256(extractFencedRegion(read(dir, CLASS))));
	assert.equal(lock.block, sha256(fs.readFileSync(path.join(dir, BLOCK))));
	assert.equal(lock.cliVersion, pkg.version);
	assert.equal(partialLockPath(dir, 'hero'), `${dir}/${LOCK}`);
	// The lock lives beside the manifest tree, never inside a manifest.
	assert.equal(readManifest(dir).lock, undefined);
	assert.equal(JSON.stringify(readManifest(dir)).includes(lock.classFence), false);
}));

test('a partial without a block omits the block hash', withTheme(async (dir) => {
	await createHero(dir);
	assert.deepEqual(Object.keys(readLock(dir)), ['manifest', 'classFence', 'cliVersion']);
}));

test('clean right after create, and edits outside the fence stay clean', withTheme(async (dir) => {
	const manifest = await createHero(dir, { '--block': true });
	let result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'clean');
	assert.deepEqual(result.changes, []);
	assert.equal(result.ok, true);

	write(dir, CLASS, read(dir, CLASS).replace(`${FENCE_CLOSE}\n`, `${FENCE_CLOSE}\n${USER_METHOD}`));
	result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'clean');
}));

test('pending: the manifest changed since the last sync', withTheme(async (dir) => {
	let manifest = await createHero(dir, { '--block': true });

	// A reformat changes the bytes but not what sync writes: pending, still ok.
	write(dir, MANIFEST, JSON.stringify(manifest) + '\n');
	let result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'pending');
	assert.deepEqual(result.changes.map((c) => [c.artifact, c.region, c.kind, c.state]), [['manifest', null, 'edited', 'pending']]);
	assert.equal(result.ok, true);

	// A real contract change: pending, and the generated files are out of step.
	manifest = addProp(dir, manifest, 'dek');
	result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'pending');
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((i) => i.code === 'class_drift'));
	assert.match(result.changes[0].message, /partial sync Hero/);
}));

test('conflict: an edit inside the class fence', withTheme(async (dir) => {
	const manifest = await createHero(dir);
	editFence(dir);
	const result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'conflict');
	assert.deepEqual(result.changes.map((c) => [c.artifact, c.region, c.kind, c.state]), [['class', 'fence', 'edited', 'conflict']]);
	assert.match(result.changes[0].message, new RegExp(CLASS.replace(/[.]/g, '\\.')));
	assert.equal(result.ok, false);
}));

test('conflict: block.json edited by hand, even where attribute names still match', withTheme(async (dir) => {
	const manifest = await createHero(dir, { '--block': true });
	editBlock(dir);
	const result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'conflict');
	assert.deepEqual(result.changes.map((c) => [c.artifact, c.region, c.kind]), [['block', 'file', 'edited']]);
	// The binary comparison cannot see a title edit; the conflict still fails ok.
	assert.equal(result.ok, false);
	assert.ok(result.issues.some((i) => i.code === 'conflict'));
}));

test('conflict wins when the manifest and the fence both changed', withTheme(async (dir) => {
	let manifest = await createHero(dir, { '--block': true });
	manifest = addProp(dir, manifest, 'dek');
	editFence(dir);
	editBlock(dir);
	const result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'conflict');
	const kinds = result.changes.map((c) => `${c.artifact}:${c.state}`).sort();
	assert.deepEqual(kinds, ['block:conflict', 'class:conflict', 'manifest:pending']);
}));

test('a lock-less legacy partial is pending (never clean) with the binary result', withTheme(async (dir) => {
	let manifest = await createHero(dir);
	fs.removeSync(path.join(dir, LOCK));

	let result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'pending');
	assert.equal(result.changes.length, 1);
	assert.equal(result.changes[0].kind, 'no_lock');
	assert.match(result.changes[0].message, /No sync lock yet .*match the manifest/);
	assert.equal(result.ok, true, 'files that match are reported, not failed');

	// Without a lock a hand edit cannot be told from a manifest edit: pending.
	editFence(dir);
	result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'pending');
	assert.match(result.changes[0].message, /differ from the manifest/);
	assert.equal(result.ok, false);

	// The first sync writes the lock.
	manifest = readManifest(dir);
	syncPartialFromManifest(manifest, dir);
	assert.ok(fs.existsSync(path.join(dir, LOCK)));
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
}));

test('missing generated files are pending, not conflict', withTheme(async (dir) => {
	const manifest = await createHero(dir, { '--block': true });
	fs.removeSync(path.join(dir, BLOCK));
	fs.removeSync(path.join(dir, CLASS));
	const result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'pending');
	assert.deepEqual(result.changes.map((c) => [c.artifact, c.kind]).sort(), [['block', 'missing'], ['class', 'missing']]);
}));

test('block create after the last sync leaves block.json unrecorded (pending) until sync', withTheme(async (dir) => {
	await createHero(dir);
	assert.equal(addBlock(dir, 'Hero'), true);
	const result = checkPartialDrift(readManifest(dir), dir);
	assert.equal(result.state, 'pending');
	assert.ok(result.changes.some((c) => c.artifact === 'block' && c.kind === 'unrecorded'));
	syncPartialFromManifest(readManifest(dir), dir);
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
	assert.ok(readLock(dir).block);
}));

test('a CRLF checkout of committed files is not a conflict', withTheme(async (dir) => {
	const manifest = await createHero(dir, { '--block': true });
	for (const rel of [CLASS, BLOCK, MANIFEST]) {
		write(dir, rel, read(dir, rel).replace(/\n/g, '\r\n'));
	}
	assert.equal(checkPartialDrift(manifest, dir).state, 'clean');
	assert.equal(contentHash('a\r\nb\n'), contentHash('a\nb\n'));
	assert.notEqual(contentHash('a\nb\n'), contentHash('a\nb'));
}));

test('sync clears pending and rewrites the lock', withTheme(async (dir) => {
	let manifest = await createHero(dir);
	const before = readLock(dir);
	manifest = addProp(dir, manifest, 'dek');
	assert.equal(checkPartialDrift(manifest, dir).state, 'pending');

	syncPartialFromManifest(manifest, dir);
	const after = readLock(dir);
	assert.notEqual(after.manifest, before.manifest);
	assert.notEqual(after.classFence, before.classFence);
	assert.equal(after.manifest, sha256(fs.readFileSync(path.join(dir, MANIFEST))), 'hash of the manifest as sync normalized it');
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
}));

test('sync refuses a conflict and writes nothing; --force clears it and keeps code outside the fence', withTheme(async (dir) => {
	let manifest = await createHero(dir, { '--block': true });
	write(dir, CLASS, read(dir, CLASS).replace(`${FENCE_CLOSE}\n`, `${FENCE_CLOSE}\n${USER_METHOD}`));
	syncPartialFromManifest(readManifest(dir), dir);
	manifest = addProp(dir, readManifest(dir), 'dek');
	editFence(dir);
	const classBefore = read(dir, CLASS);
	const lockBefore = read(dir, LOCK);
	const blockBefore = read(dir, BLOCK);

	assert.throws(() => syncPartialFromManifest(manifest, dir), (err) => {
		assert.ok(err instanceof SyncConflictError);
		assert.equal(err.code, 'conflict');
		assert.match(err.message, /hero/);
		assert.match(err.message, /class generated region \(edited\)/);
		assert.match(err.hint, /IDE/);
		assert.match(err.hint, /--force/);
		return true;
	});
	assert.equal(read(dir, CLASS), classBefore, 'class untouched');
	assert.equal(read(dir, BLOCK), blockBefore, 'block.json untouched');
	assert.equal(read(dir, LOCK), lockBefore, 'lock untouched');

	const plan = syncPartialFromManifest(manifest, dir, { dryRun: true });
	assert.equal(plan.state, 'conflict');
	assert.equal(plan.blocked, true);
	assert.match(plan.conflictError, /Refusing to sync hero/);

	const result = syncPartialFromManifest(manifest, dir, { force: true });
	assert.equal(result.classMode, 'update', 'force past a conflict still splices only the region');
	const after = read(dir, CLASS);
	assert.ok(after.includes(USER_METHOD), 'custom method below the fence survives --force');
	assert.match(extractFencedRegion(after), /'dek'/);
	assert.match(extractFencedRegion(after), /'required'    => true/, 'hand edit inside the fence overwritten');
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
}));

test('sync refuses a block.json conflict too, and --force regenerates block.json', withTheme(async (dir) => {
	const manifest = await createHero(dir, { '--block': true });
	editBlock(dir);
	assert.throws(() => syncPartialFromManifest(manifest, dir), (err) => err.code === 'conflict' && /block\.json \(edited\)/.test(err.message));
	syncPartialFromManifest(manifest, dir, { force: true });
	assert.notEqual(JSON.parse(read(dir, BLOCK)).title, 'Hand-edited title');
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
}));

test('a fenced class whose markers were deleted since the last sync is a conflict', withTheme(async (dir) => {
	const manifest = await createHero(dir);
	write(dir, CLASS, read(dir, CLASS).replace(`\t${FENCE_OPEN}\n`, '').replace(`\t${FENCE_CLOSE}\n`, ''));
	const result = checkPartialDrift(manifest, dir);
	assert.equal(result.state, 'conflict');
	assert.equal(result.changes[0].kind, 'unfenced');
}));

test('partial remove deletes the lock', withTheme(async (dir) => {
	await createHero(dir);
	assert.ok(fs.existsSync(path.join(dir, LOCK)));
	assert.equal(await removePartial(dir, 'Hero'), true);
	assert.equal(fs.existsSync(path.join(dir, LOCK)), false);
}));

// --- CLI ---------------------------------------------------------------

function cliEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lock-cli-'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), '{}');
	const themeDir = path.join(root, 'wp-content/themes/smoke');
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	const run = (argv) => spawnSync('node', [BIN, ...argv, '--dir', root, '--theme', 'smoke'], { encoding: 'utf8' });
	return { root, themeDir, run };
}

function oneEnvelope(result) {
	const lines = result.stdout.trim().split('\n');
	assert.equal(lines.length, 1, `exactly one envelope on stdout, got:\n${result.stdout}`);
	return parseEnvelope(result.stdout);
}

test('CLI: check-drift --format json reports data.partials with state and changes', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--no-style']);
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style']);

		const clean = run(['partial', 'check-drift', '--all', '--format', 'json']);
		assert.equal(clean.status, 0, clean.stderr);
		const ok = oneEnvelope(clean);
		assert.equal(ok.ok, true);
		assert.deepEqual(ok.data.partials, [
			{ slug: 'card', state: 'clean', changes: [] },
			{ slug: 'hero', state: 'clean', changes: [] },
		]);

		editFence(themeDir);
		const conflicted = run(['partial', 'check-drift', '--all', '--format', 'json']);
		assert.equal(conflicted.status, 1);
		const body = oneEnvelope(conflicted);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'conflict');
		const hero = body.data.partials.find((p) => p.slug === 'hero');
		assert.equal(hero.state, 'conflict');
		assert.deepEqual(Object.keys(hero.changes[0]).sort(), ['artifact', 'kind', 'message', 'region', 'state']);
		assert.equal(body.data.partials.find((p) => p.slug === 'card').state, 'clean');
		assert.ok(Array.isArray(body.data.results), 'legacy results kept');
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: check-drift human output is silent for clean partials and one line per other', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--no-style']);
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style']);
		const silent = run(['partial', 'check-drift', '--all']);
		assert.equal(silent.status, 0);
		assert.equal((silent.stdout + silent.stderr).trim(), '');

		// Pending with matching files (reformatted manifest): warned, exit 0.
		const cardManifest = path.join(themeDir, '.wonderpress/manifest/partials/card.json');
		fs.writeFileSync(cardManifest, JSON.stringify(JSON.parse(fs.readFileSync(cardManifest, 'utf8'))) + '\n');
		editFence(themeDir);
		const noisy = run(['partial', 'check-drift', '--all']);
		assert.equal(noisy.status, 1, 'the conflict fails');
		const lines = (noisy.stdout + noisy.stderr).trim().split('\n').filter(Boolean);
		assert.equal(lines.length, 2, lines.join('\n'));
		assert.ok(lines.some((l) => /card: pending \(manifest edited\)/.test(l)));
		assert.ok(lines.some((l) => /hero: conflict \(class generated region edited\).*--force/.test(l)));
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: sync refuses a conflict with a JSON error; --all skips it and syncs the rest', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--no-style']);
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style']);
		editFence(themeDir);
		const card = path.join(themeDir, '.wonderpress/manifest/partials/card.json');
		const m = JSON.parse(fs.readFileSync(card, 'utf8'));
		m.properties.push({ name: 'dek', type: 'string', required: false, description: '' });
		fs.writeFileSync(card, JSON.stringify(m, null, 2) + '\n');

		const refused = run(['partial', 'sync', 'Hero', '--format', 'json']);
		assert.equal(refused.status, 1);
		const body = oneEnvelope(refused);
		assert.equal(body.error.code, 'conflict');
		assert.match(body.error.message, /hero/);
		assert.match(body.error.hint, /IDE/);

		const all = run(['partial', 'sync', '--all', '--format', 'json']);
		assert.equal(all.status, 0, all.stderr);
		const summary = oneEnvelope(all);
		assert.deepEqual(summary.data.synced, ['card']);
		assert.equal(summary.data.skipped.length, 1);
		assert.equal(summary.data.skipped[0].slug, 'hero');
		assert.match(all.stderr, /Skipped hero/);

		const forced = run(['partial', 'sync', 'Hero', '--force', '--format', 'json']);
		assert.equal(forced.status, 0, forced.stderr);
		assert.equal(oneEnvelope(forced).ok, true);
		const after = oneEnvelope(run(['partial', 'check-drift', '--all', '--format', 'json']));
		assert.deepEqual(after.data.partials.map((p) => p.state), ['clean', 'clean']);
	} finally {
		fs.removeSync(root);
	}
});

// --- lint and MCP ------------------------------------------------------

function mcpEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lock-mcp-'));
	const themeDir = path.join(root, 'wp-content/themes/acme');
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	fs.writeFileSync(path.join(themeDir, 'style.css'), '/* Theme Name: Acme */');
	// A phpcs stub that passes, so lint's result is about drift alone.
	fs.ensureDirSync(path.join(root, 'vendor/bin'));
	fs.writeFileSync(path.join(root, 'vendor/autoload.php'), '<?php');
	writeStubBin(path.join(root, 'vendor/bin'), 'phpcs', `process.stdout.write('{"totals":{"errors":0,"warnings":0,"fixable":0},"files":{}}\\n');\n`);
	return { root, themeDir };
}

test('lint: conflict is an error, pending with matching files is a warning', async () => {
	const { root, themeDir } = mcpEnv();
	const cwd = process.cwd();
	try {
		process.chdir(root);
		await createHero(themeDir);
		fs.removeSync(path.join(themeDir, LOCK));

		let result = await inspectTheme(root, { name: 'acme' });
		assert.equal(result.data.drift.ok, true, 'a lock-less legacy partial does not fail lint');
		assert.deepEqual(result.data.drift.states, { clean: 0, pending: 1, conflict: 0 });
		assert.equal(result.data.drift.partials[0].state, 'pending');
		assert.equal(result.ok, true);

		syncPartialFromManifest(readManifest(themeDir), themeDir);
		editFence(themeDir);
		result = await inspectTheme(root, { name: 'acme' });
		assert.equal(result.ok, false);
		assert.equal(result.data.drift.ok, false);
		assert.deepEqual(result.data.drift.states, { clean: 0, pending: 0, conflict: 1 });
		assert.match(result.data.hint, /conflict/);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('lint (human): one line per non-clean partial; a conflict fails, pending warns', async () => {
	const { root, themeDir } = mcpEnv();
	const cwd = process.cwd();
	const previousExit = process.exitCode;
	const lines = [];
	const original = console.log;
	console.log = (line) => lines.push(String(line));
	try {
		process.chdir(root);
		await createHero(themeDir);
		fs.removeSync(path.join(themeDir, LOCK));
		process.exitCode = 0;
		await lintCommand('theme', { '--dir': root, '--name': 'acme' });
		assert.equal(process.exitCode ?? 0, 0, 'pending with matching files passes lint');
		assert.equal(lines.filter((l) => /hero: pending \(no sync lock yet\)/.test(l)).length, 1);

		syncPartialFromManifest(readManifest(themeDir), themeDir);
		editFence(themeDir);
		lines.length = 0;
		await lintCommand('theme', { '--dir': root, '--name': 'acme' });
		assert.equal(process.exitCode, 1);
		assert.equal(lines.filter((l) => /hero: conflict \(class generated region edited\)/.test(l)).length, 1);
	} finally {
		console.log = original;
		process.exitCode = previousExit;
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('MCP: partial_check_drift returns partials with state and changes; partial_sync refuses a conflict', async () => {
	const { root, themeDir } = mcpEnv();
	const cwd = process.cwd();
	const parse = (r) => JSON.parse(r.content[0].text);
	try {
		process.chdir(root);
		await createHero(themeDir, { '--block': true });

		let drift = parse(await handlers.partial_check_drift({ dir: root, theme: 'acme' }));
		assert.equal(drift.ok, true);
		assert.deepEqual(drift.partials, [{ slug: 'hero', state: 'clean', changes: [] }]);

		editBlock(themeDir);
		drift = parse(await handlers.partial_check_drift({ dir: root, theme: 'acme', slug: 'hero' }));
		assert.equal(drift.ok, false);
		assert.equal(drift.partials[0].state, 'conflict');
		assert.deepEqual(
			drift.partials[0].changes.map((c) => [c.artifact, c.region, c.kind, c.state]),
			[['block', 'file', 'edited', 'conflict']],
		);

		const refused = parse(await handlers.partial_sync({ dir: root, theme: 'acme', name: 'Hero' }));
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, 'conflict');

		const all = parse(await handlers.partial_sync({ dir: root, theme: 'acme', all: true }));
		assert.equal(all.ok, true);
		assert.deepEqual(all.synced, []);
		assert.equal(all.skipped[0].slug, 'hero');

		const forced = parse(await handlers.partial_sync({ dir: root, theme: 'acme', name: 'Hero', force: true }));
		assert.equal(forced.ok, true);
		drift = parse(await handlers.partial_check_drift({ dir: root, theme: 'acme' }));
		assert.equal(drift.partials[0].state, 'clean');
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

// --- refusals the fence writer and other writers share with sync ---------

const unfence = (dir) => write(dir, CLASS, read(dir, CLASS).replace(`\t${FENCE_OPEN}\n`, '').replace(`\t${FENCE_CLOSE}\n`, ''));
const breakFence = (dir) => write(dir, CLASS, read(dir, CLASS).replace(`\t${FENCE_CLOSE}\n`, ''));

for (const [kind, damage, fenceCode] of [['unfenced', unfence, 'class_unfenced'], ['malformed', breakFence, 'class_fence']]) {
	test(`a ${kind} class since the last sync is refused as a conflict (code conflict), carrying the fence advice`, withTheme(async (dir) => {
		const manifest = await createHero(dir);
		damage(dir);
		const before = read(dir, CLASS);
		assert.equal(checkPartialDrift(manifest, dir).changes[0].kind, kind);
		assert.throws(() => syncPartialFromManifest(manifest, dir), (err) => {
			assert.ok(err instanceof SyncConflictError, `${err.name}: ${err.message}`);
			assert.equal(err.code, 'conflict', `not ${fenceCode}`);
			assert.match(err.message, new RegExp(`class generated region \\(${kind}\\)`));
			assert.match(err.message, /--force/);
			return true;
		});
		assert.equal(read(dir, CLASS), before, 'nothing written on refusal');
		syncPartialFromManifest(manifest, dir, { force: true });
		assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
	}));
}

test('CLI: sync --all skips unfenced and malformed conflicts and lock-less fence refusals instead of aborting', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		// Sorted: alpha (fine) < hero (damaged) < zulu (fine). An abort at hero
		// would leave zulu unsynced.
		for (const name of ['Alpha', 'Hero', 'Zulu']) {
			run(['partial', 'create', '--name', name, '--prop', 'title:string:required', '--no-style']);
		}
		const pend = (slug) => {
			const file = path.join(themeDir, `.wonderpress/manifest/partials/${slug}.json`);
			const m = JSON.parse(fs.readFileSync(file, 'utf8'));
			m.properties.push({ name: `dek${m.properties.length}`, type: 'string', required: false, description: '' });
			fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
		};
		const cases = [
			['unfenced', unfence, 'conflict'],
			['malformed', breakFence, 'conflict'],
			// No lock: not a conflict, but the writer still refuses the
			// hand-edited unfenced file. Same outcome for --all: skip it.
			['lock-less unfenced', (dir) => { unfence(dir); fs.removeSync(path.join(dir, LOCK)); }, 'class_unfenced'],
		];
		for (const [label, damage, code] of cases) {
			pend('alpha');
			pend('zulu');
			damage(themeDir);
			const drift = oneEnvelope(run(['partial', 'check-drift', '--all', '--format', 'json']));
			assert.equal(drift.data.partials.find((p) => p.slug === 'hero').state, code === 'conflict' ? 'conflict' : 'pending', label);

			const all = run(['partial', 'sync', '--all', '--format', 'json']);
			assert.equal(all.status, 0, `${label}: ${all.stdout}${all.stderr}`);
			const body = oneEnvelope(all);
			assert.deepEqual(body.data.synced, ['alpha', 'zulu'], label);
			assert.deepEqual(body.data.skipped.map((s) => [s.slug, s.code]), [['hero', code]], label);
			assert.match(all.stderr, /Skipped hero/);

			const human = run(['partial', 'sync', '--all']);
			assert.equal(human.status, 0, `${label} (human): ${human.stdout}${human.stderr}`);
			assert.match(human.stdout + human.stderr, /Skipped 1 that sync refused \(hero\)/);

			assert.equal(oneEnvelope(run(['partial', 'sync', 'Hero', '--force', '--format', 'json'])).ok, true, label);
		}
	} finally {
		fs.removeSync(root);
	}
});

test('MCP: partial_sync with all skips an unfenced conflict instead of failing the run', async () => {
	const { root, themeDir } = mcpEnv();
	const cwd = process.cwd();
	const parse = (r) => JSON.parse(r.content[0].text);
	try {
		process.chdir(root);
		await createHero(themeDir);
		await writePartial(paramsFromFlags({ '--name': 'Zulu', '--no-style': true }), themeDir);
		unfence(themeDir);
		const all = parse(await handlers.partial_sync({ dir: root, theme: 'acme', all: true }));
		assert.equal(all.ok, true, JSON.stringify(all));
		assert.deepEqual(all.synced, ['zulu']);
		assert.deepEqual(all.skipped.map((s) => [s.slug, s.code]), [['hero', 'conflict']]);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('block create refuses to overwrite a hand-edited block.json; --force does, and the state is honest', withTheme(async (dir) => {
	await createHero(dir, { '--block': true });
	editBlock(dir);
	const before = read(dir, BLOCK);
	assert.throws(() => addBlock(dir, 'Hero'), (err) => {
		assert.ok(err instanceof SyncConflictError);
		assert.equal(err.code, 'conflict');
		assert.match(err.message, /block\.json \(edited\)/);
		assert.match(err.hint, /wonderpress block create Hero --force/);
		return true;
	});
	assert.equal(read(dir, BLOCK), before, 'hand edits kept');
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'conflict', 'still reported, not hidden');

	assert.equal(addBlock(dir, 'Hero', { force: true }), true);
	assert.notEqual(JSON.parse(read(dir, BLOCK)).title, 'Hand-edited title');
}));

test('block create ignores a class conflict: it only rewrites block.json', withTheme(async (dir) => {
	await createHero(dir, { '--block': true });
	editFence(dir);
	const classBefore = read(dir, CLASS);
	assert.equal(addBlock(dir, 'Hero'), true);
	assert.equal(read(dir, CLASS), classBefore);
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'conflict');
}));

test('re-running partial create refuses a partial in conflict; --force regenerates it', withTheme(async (dir) => {
	await createHero(dir, { '--block': true });
	const flags = { '--name': 'Hero', '--prop': ['title:string:required'], '--no-style': true, '--block': true };

	editBlock(dir);
	const blockBefore = read(dir, BLOCK);
	const lockBefore = read(dir, LOCK);
	await assert.rejects(writePartial(paramsFromFlags(flags), dir), (err) => {
		assert.ok(err instanceof SyncConflictError);
		assert.equal(err.code, 'conflict');
		assert.match(err.message, /block\.json \(edited\)/);
		assert.match(err.hint, /wonderpress partial create --name Hero --force/);
		return true;
	});
	assert.equal(read(dir, BLOCK), blockBefore, 'block.json untouched');
	assert.equal(read(dir, LOCK), lockBefore, 'lock not re-recorded over the edit');
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'conflict');

	// A hand edit inside the fence is protected the same way.
	await writePartial(paramsFromFlags(flags), dir, { force: true });
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
	editFence(dir);
	const classBefore = read(dir, CLASS);
	await assert.rejects(writePartial(paramsFromFlags(flags), dir), (err) => err.code === 'conflict' && /class generated region \(edited\)/.test(err.message));
	assert.equal(read(dir, CLASS), classBefore, 'class untouched');

	// Pending (a manifest edit) is not a conflict: re-create proceeds.
	await writePartial(paramsFromFlags(flags), dir, { force: true });
	addProp(dir, readManifest(dir), 'dek');
	await writePartial(paramsFromFlags(flags), dir);
	assert.equal(checkPartialDrift(readManifest(dir), dir).state, 'clean');
}));

test('CLI: block create and a partial create re-run refuse a block.json conflict with one JSON envelope', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style', '--block']);
		const blockFile = path.join(themeDir, 'blocks/card/block.json');
		const handEdit = () => {
			const b = JSON.parse(fs.readFileSync(blockFile, 'utf8'));
			b.title = 'Hand title';
			b.supports = { align: true };
			fs.writeFileSync(blockFile, JSON.stringify(b, null, 2) + '\n');
			return fs.readFileSync(blockFile, 'utf8');
		};
		const state = () => oneEnvelope(run(['partial', 'check-drift', 'Card', '--format', 'json'])).data.partials[0].state;

		const edited = handEdit();
		for (const argv of [
			['block', 'create', '--name', 'Card'],
			['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style', '--block'],
		]) {
			const refused = run([...argv, '--format', 'json']);
			assert.equal(refused.status, 1, `${argv.join(' ')}: ${refused.stdout}`);
			const body = oneEnvelope(refused);
			assert.equal(body.error.code, 'conflict');
			assert.match(body.error.message, /card/);
			assert.match(body.error.hint, /--force/);
			assert.equal(fs.readFileSync(blockFile, 'utf8'), edited, 'hand edits kept');
			assert.equal(state(), 'conflict');
		}

		const forced = run(['block', 'create', '--name', 'Card', '--force', '--format', 'json']);
		assert.equal(forced.status, 0, forced.stderr);
		assert.notEqual(JSON.parse(fs.readFileSync(blockFile, 'utf8')).title, 'Hand title');

		handEdit();
		const reforced = run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style', '--block', '--force', '--format', 'json']);
		assert.equal(reforced.status, 0, reforced.stderr);
		assert.equal(state(), 'clean');
	} finally {
		fs.removeSync(root);
	}
});

test('MCP: block_create and partial_create refuse a conflict with code "conflict" and accept force', async () => {
	const { root, themeDir } = mcpEnv();
	const cwd = process.cwd();
	const parse = (r) => JSON.parse(r.content[0].text);
	try {
		process.chdir(root);
		await createHero(themeDir, { '--block': true });
		editBlock(themeDir);
		const spec = { name: 'Hero', properties: [{ name: 'title', type: 'string', required: true }], block: true, style: false };

		const block = parse(await handlers.block_create({ dir: root, theme: 'acme', name: 'Hero' }));
		assert.equal(block.ok, false);
		assert.equal(block.error.code, 'conflict');
		const created = parse(await handlers.partial_create({ dir: root, theme: 'acme', spec }));
		assert.equal(created.ok, false);
		assert.equal(created.error.code, 'conflict');
		assert.match(read(themeDir, BLOCK), /Hand-edited title/);

		assert.equal(parse(await handlers.block_create({ dir: root, theme: 'acme', name: 'Hero', force: true })).ok, true);
		editBlock(themeDir);
		assert.equal(parse(await handlers.partial_create({ dir: root, theme: 'acme', spec, force: true })).ok, true);
		assert.doesNotMatch(read(themeDir, BLOCK), /Hand-edited title/);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});
