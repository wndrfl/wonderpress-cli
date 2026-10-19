// The app-facing JSON halves of `partial remove` and `partial sync`: remove
// reports what it deleted and never prompts, and a real sync reports each
// partial's drift after the write so the app needs one call per save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnvelope } from '../src/format.js';
import { FENCE_CLOSE } from '../src/partial-class.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

// A theme with a minimal assets tree, so style/script halves actually land.
function cliEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-remove-json-'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), '{}');
	const themeDir = path.join(root, 'wp-content/themes/smoke');
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	fs.ensureDirSync(path.join(themeDir, 'static'));
	fs.writeFileSync(path.join(themeDir, 'static/.staticrc'), JSON.stringify({
		paths: {
			src: { js: 'src/js', scss: 'src/scss', images: 'src/images' },
			dist: { js: 'dist/js', css: 'dist/css', images: 'dist/images' },
		},
	}));
	// stdin is not a TTY under spawnSync, which is the case the app is in.
	const run = (argv) => spawnSync('node', [BIN, ...argv, '--dir', root, '--theme', 'smoke'], { encoding: 'utf8' });
	return { root, themeDir, run };
}

function oneEnvelope(result) {
	const lines = result.stdout.trim().split('\n');
	assert.equal(lines.length, 1, `exactly one envelope on stdout, got:\n${result.stdout}\n${result.stderr}`);
	return parseEnvelope(result.stdout);
}

const exists = (themeDir, rel) => fs.existsSync(path.join(themeDir, rel));

// --- partial remove ------------------------------------------------------

test('CLI: partial remove --yes --format json lists every path it deleted', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--js']);
		const manifest = JSON.parse(fs.readFileSync(path.join(themeDir, '.wonderpress/manifest/partials/hero.json'), 'utf8'));
		const { style, script } = manifest.artifacts;
		assert.ok(style && script, 'the assets halves were recorded');

		const result = run(['partial', 'remove', 'hero', '--yes', '--format', 'json']);
		assert.equal(result.status, 0, result.stderr);
		const body = oneEnvelope(result);
		assert.equal(body.ok, true);
		assert.equal(body.data.slug, 'hero');
		assert.deepEqual([...body.data.removed].sort(), [
			'.wonderpress/manifest/partials/hero.json',
			'.wonderpress/manifest/partials/hero.lock.json',
			'partials/hero.php',
			script,
			'src/partials/class-hero.php',
			style,
		].sort());
		assert.equal(new Set(body.data.removed).size, body.data.removed.length, 'no path listed twice');
		for (const rel of body.data.removed) {
			assert.ok(!exists(themeDir, rel), `${rel} is gone`);
		}
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: partial remove --format json refuses a wrapped partial with has_block, and --with-block removes the block too', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style', '--block']);
		assert.ok(exists(themeDir, 'blocks/card/block.json'));

		const refused = run(['partial', 'remove', 'Card', '--yes', '--format', 'json']);
		assert.equal(refused.status, 1);
		const body = oneEnvelope(refused);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'has_block');
		assert.match(body.error.hint, /--with-block/);
		assert.ok(exists(themeDir, 'src/partials/class-card.php'), 'nothing deleted on refusal');
		assert.ok(exists(themeDir, '.wonderpress/manifest/partials/card.json'));

		const removed = run(['partial', 'remove', 'Card', '--with-block', '--yes', '--format', 'json']);
		assert.equal(removed.status, 0, removed.stderr);
		const ok = oneEnvelope(removed);
		assert.ok(ok.data.removed.includes('blocks/card'));
		assert.ok(ok.data.removed.includes('src/partials/class-card.php'));
		assert.ok(ok.data.removed.includes('.wonderpress/manifest/partials/card.json'));
		assert.ok(!exists(themeDir, 'blocks/card'));
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: partial remove --format json reports not_found with the known slugs, and usage without a name', () => {
	const { root, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--no-style']);
		run(['partial', 'create', '--name', 'Card', '--no-style']);

		const missing = run(['partial', 'remove', 'Nope', '--yes', '--format', 'json']);
		assert.equal(missing.status, 1);
		const body = oneEnvelope(missing);
		assert.equal(body.error.code, 'not_found');
		assert.match(body.error.hint, /card/);
		assert.match(body.error.hint, /hero/);

		// No name means a picker, which JSON (with or without --yes) never shows.
		for (const argv of [['--format', 'json'], ['--yes', '--format', 'json']]) {
			const usage = run(['partial', 'remove', ...argv]);
			assert.equal(usage.status, 2, argv.join(' '));
			const err = oneEnvelope(usage);
			assert.equal(err.error.code, 'usage');
			assert.match(err.error.hint, /hero/);
		}
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: human partial remove output is unchanged', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--no-style']);
		const result = run(['partial', 'remove', 'Hero', '--yes']);
		assert.equal(result.status, 0, result.stderr);
		assert.doesNotMatch(result.stdout, /^\{/m, 'no envelope in human mode');
		assert.match(result.stdout + result.stderr, /Removed manifest/);
		assert.ok(!exists(themeDir, '.wonderpress/manifest/partials/hero.json'));
	} finally {
		fs.removeSync(root);
	}
});

// --- partial sync drift --------------------------------------------------

test('CLI: partial sync --format json reports drift clean after the write', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--no-style']);
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style']);

		// Owe a sync: the manifest changed since the last one.
		const file = path.join(themeDir, '.wonderpress/manifest/partials/hero.json');
		const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
		manifest.properties.push({ name: 'dek', type: 'string', required: false, description: '' });
		fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
		const before = oneEnvelope(run(['partial', 'check-drift', 'Hero', '--format', 'json']));
		assert.equal(before.data.partials[0].state, 'pending');

		const one = run(['partial', 'sync', 'Hero', '--format', 'json']);
		assert.equal(one.status, 0, one.stderr);
		assert.deepEqual(oneEnvelope(one).data, {
			dryRun: false,
			synced: [{ slug: 'hero', drift: { state: 'clean', changes: [] } }],
		});

		const all = run(['partial', 'sync', '--all', '--format', 'json']);
		assert.equal(all.status, 0, all.stderr);
		const body = oneEnvelope(all);
		assert.deepEqual(body.data.synced, [
			{ slug: 'card', drift: { state: 'clean', changes: [] } },
			{ slug: 'hero', drift: { state: 'clean', changes: [] } },
		]);
		assert.deepEqual(body.data.skipped, []);

		// The same object check-drift reports for the slug.
		const drift = oneEnvelope(run(['partial', 'check-drift', '--all', '--format', 'json']));
		assert.deepEqual(
			body.data.synced.map((s) => ({ slug: s.slug, ...s.drift })),
			drift.data.partials,
		);

		// Dry runs keep their plans shape.
		const dry = oneEnvelope(run(['partial', 'sync', 'Hero', '--dry-run', '--format', 'json']));
		assert.equal(dry.data.dryRun, true);
		assert.ok(Array.isArray(dry.data.plans));
		assert.equal(dry.data.synced, undefined);
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: a sync refused by a conflict keeps the conflict envelope; --all skips it and reports drift for the rest', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--no-style']);
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string', '--no-style']);
		const cls = path.join(themeDir, 'src/partials/class-hero.php');
		fs.writeFileSync(cls, fs.readFileSync(cls, 'utf8').replace(`\t${FENCE_CLOSE}`, `\t// hand edit\n\t${FENCE_CLOSE}`));

		const refused = run(['partial', 'sync', 'Hero', '--format', 'json']);
		assert.equal(refused.status, 1);
		const body = oneEnvelope(refused);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'conflict');

		const all = oneEnvelope(run(['partial', 'sync', '--all', '--format', 'json']));
		assert.deepEqual(all.data.synced, [{ slug: 'card', drift: { state: 'clean', changes: [] } }]);
		assert.deepEqual(all.data.skipped.map((s) => [s.slug, s.code]), [['hero', 'conflict']]);

		const forced = oneEnvelope(run(['partial', 'sync', 'Hero', '--force', '--format', 'json']));
		assert.deepEqual(forced.data.synced, [{ slug: 'hero', drift: { state: 'clean', changes: [] } }]);
	} finally {
		fs.removeSync(root);
	}
});
