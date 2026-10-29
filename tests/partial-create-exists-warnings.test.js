// `partial create` on a partial that already exists is refused (error
// `exists`) unless --force, and a style/JS half Static Kit could not write is
// reported in the JSON envelope as data.warnings rather than only on stderr.
//
// Both came out of the desktop app wrapping `partial create --format json`:
// a re-run silently rewrote the manifest from the flags, and a skipped JS half
// looked like success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnvelope } from '../src/format.js';
import { addScript, findExistingPartial, paramsFromFlags, writePartial } from '../src/partial.js';
import { handlers } from '../src/mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

const STATICRC = JSON.stringify({
	paths: {
		src: { js: 'src/js', scss: 'src/scss', images: 'src/images' },
		dist: { js: 'dist/js', css: 'dist/css', images: 'dist/images' },
	},
});

// A theme fixture; `withStatic` adds the minimal Static Kit tree so the
// delegated halves land, without it `component.create` has nothing to write to.
function cliEnv({ withStatic = true } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-create-exists-'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), '{}');
	const themeDir = path.join(root, 'wp-content/themes/smoke');
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	if (withStatic) {
		fs.ensureDirSync(path.join(themeDir, 'static'));
		fs.writeFileSync(path.join(themeDir, 'static/.staticrc'), STATICRC);
	}
	// stdin is not a TTY under spawnSync, which is the case the app is in.
	const run = (argv) => spawnSync('node', [BIN, ...argv, '--dir', root, '--theme', 'smoke', '--format', 'json'], { encoding: 'utf8' });
	return { root, themeDir, run };
}

function oneEnvelope(result) {
	const lines = result.stdout.trim().split('\n');
	assert.equal(lines.length, 1, `exactly one envelope on stdout, got:\n${result.stdout}\n${result.stderr}`);
	return parseEnvelope(result.stdout);
}

const read = (themeDir, rel) => fs.readFileSync(path.join(themeDir, rel), 'utf8');
const exists = (themeDir, rel) => fs.existsSync(path.join(themeDir, rel));

// --- the exists refusal ---------------------------------------------------

test('CLI: partial create refuses an existing partial (manifest) with code exists and touches nothing', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		const first = run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--block']);
		assert.equal(first.status, 0, first.stderr);

		// Hand-curated manifest content a re-run from the flags would drop.
		const manifestFile = path.join(themeDir, '.wonderpress/manifest/partials/hero.json');
		const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		manifest.properties[0].label = 'Headline';
		manifest.properties[0].description = 'Shown above the fold';
		fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
		const before = {
			manifest: read(themeDir, '.wonderpress/manifest/partials/hero.json'),
			cls: read(themeDir, 'src/partials/class-hero.php'),
			view: read(themeDir, 'partials/hero.php'),
			block: read(themeDir, 'blocks/hero/block.json'),
			lock: read(themeDir, '.wonderpress/locks/hero.json'),
		};

		const refused = run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string']);
		assert.equal(refused.status, 1, refused.stdout);
		const body = oneEnvelope(refused);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'exists');
		assert.match(body.error.message, /"hero" already exists/);
		assert.match(body.error.message, /\.wonderpress\/manifest\/partials\/hero\.json/);
		assert.match(body.error.message, /src\/partials\/class-hero\.php/);
		assert.match(body.error.message, /partials\/hero\.php/);
		assert.match(body.error.hint, /wonderpress partial create Hero --force/);
		assert.match(body.error.hint, /wonderpress partial sync Hero/);

		assert.deepEqual({
			manifest: read(themeDir, '.wonderpress/manifest/partials/hero.json'),
			cls: read(themeDir, 'src/partials/class-hero.php'),
			view: read(themeDir, 'partials/hero.php'),
			block: read(themeDir, 'blocks/hero/block.json'),
			lock: read(themeDir, '.wonderpress/locks/hero.json'),
		}, before, 'nothing rewritten on refusal');
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: a class at the default path with no manifest is refused with exists and the migrate hint', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		const cls = path.join(themeDir, 'src/partials/class-hero.php');
		fs.writeFileSync(cls, '<?php\nnamespace Wonderpress\\Partials;\nclass Hero extends Abstract_Partial {}\n');

		const refused = run(['partial', 'create', '--name', 'Hero']);
		assert.equal(refused.status, 1, refused.stdout);
		const body = oneEnvelope(refused);
		assert.equal(body.error.code, 'exists');
		assert.match(body.error.message, /src\/partials\/class-hero\.php/);
		assert.doesNotMatch(body.error.message, /manifest\/partials/);
		assert.match(body.error.hint, /wonderpress partial create Hero --force/);
		assert.match(body.error.hint, /wonderpress theme migrate hero/);
		assert.doesNotMatch(body.error.hint, /partial sync/, 'no manifest to sync from');
		assert.equal(fs.readFileSync(cls, 'utf8'), '<?php\nnamespace Wonderpress\\Partials;\nclass Hero extends Abstract_Partial {}\n', 'legacy class untouched');
		assert.ok(!exists(themeDir, '.wonderpress/manifest/partials/hero.json'), 'no manifest written');
		assert.ok(!exists(themeDir, 'partials/hero.php'), 'no view written');
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: a view at the default path with no manifest or class is refused with exists', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		fs.writeFileSync(path.join(themeDir, 'partials/hero.php'), '<?php // hand-written view\n');

		const refused = run(['partial', 'create', '--name', 'Hero']);
		assert.equal(refused.status, 1, refused.stdout);
		const body = oneEnvelope(refused);
		assert.equal(body.error.code, 'exists');
		assert.match(body.error.message, /partials\/hero\.php/);
		assert.doesNotMatch(body.error.message, /class-hero/);
		assert.equal(read(themeDir, 'partials/hero.php'), '<?php // hand-written view\n', 'view untouched');
		assert.ok(!exists(themeDir, 'src/partials/class-hero.php'), 'no class written');

		// A view under another name is only in the way when create would write it.
		const other = run(['partial', 'create', '--name', 'Hero', '--template-name', 'hero-alt.php']);
		assert.equal(other.status, 0, other.stdout);
		assert.ok(exists(themeDir, 'partials/hero-alt.php'));
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: --force still regenerates an existing partial', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string', '--block']);
		const manifestFile = path.join(themeDir, '.wonderpress/manifest/partials/hero.json');
		const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		manifest.properties[0].label = 'Headline';
		fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

		const forced = run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string', '--prop', 'dek:string', '--block', '--force']);
		assert.equal(forced.status, 0, forced.stderr);
		const body = oneEnvelope(forced);
		assert.equal(body.ok, true);
		assert.equal(body.data.slug, 'hero');
		assert.equal(body.data.warnings, undefined, 'every half landed');
		const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		assert.deepEqual(after.properties.map((p) => p.name), ['title', 'dek'], 'rewritten from the flags');
		assert.equal(after.properties[0].label, undefined, 'the hand-curated label is gone, as --force promises');
		assert.match(read(themeDir, 'src/partials/class-hero.php'), /'dek'/);
		const drift = oneEnvelope(run(['partial', 'check-drift', 'Hero']));
		assert.equal(drift.data.partials[0].state, 'clean');
	} finally {
		fs.removeSync(root);
	}
});

test('findExistingPartial reports the files in the way, and nothing for a fresh name', async () => {
	const { root, themeDir } = cliEnv();
	try {
		assert.deepEqual(findExistingPartial(paramsFromFlags({ '--name': 'Hero' }), themeDir), { files: [], manifest: false });

		await writePartial(paramsFromFlags({ '--name': 'Hero' }), themeDir);
		assert.deepEqual(findExistingPartial(paramsFromFlags({ '--name': 'Hero' }), themeDir), {
			files: ['.wonderpress/manifest/partials/hero.json', 'src/partials/class-hero.php', 'partials/hero.php'],
			manifest: true,
		});

		// A class the manifest relocated is found where the manifest says.
		const manifestFile = path.join(themeDir, '.wonderpress/manifest/partials/hero.json');
		const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		fs.moveSync(path.join(themeDir, 'src/partials/class-hero.php'), path.join(themeDir, 'src/lib/hero.php'));
		manifest.artifacts.class = 'src/lib/hero.php';
		fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
		assert.deepEqual(findExistingPartial(paramsFromFlags({ '--name': 'Hero' }), themeDir).files, [
			'.wonderpress/manifest/partials/hero.json', 'src/lib/hero.php', 'partials/hero.php',
		]);
	} finally {
		fs.removeSync(root);
	}
});

test('block create and partial add-js still retrofit an existing partial (they are not create)', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		run(['partial', 'create', '--name', 'Card', '--prop', 'title:string']);
		const block = oneEnvelope(run(['block', 'create', '--name', 'Card']));
		assert.equal(block.ok, true, JSON.stringify(block));
		assert.ok(exists(themeDir, 'blocks/card/block.json'));
		const js = oneEnvelope(run(['partial', 'add-js', 'Card']));
		assert.equal(js.ok, true, JSON.stringify(js));
		assert.equal(js.data.script, 'static/src/js/components/Card.js');
		assert.equal(js.data.warnings, undefined);
	} finally {
		fs.removeSync(root);
	}
});

// --- data.warnings ----------------------------------------------------------

test('CLI: partial create --format json reports a skipped style/JS half in data.warnings', () => {
	const { root, themeDir, run } = cliEnv({ withStatic: false });
	try {
		const result = run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string', '--js']);
		assert.equal(result.status, 0, result.stderr);
		const body = oneEnvelope(result);
		assert.equal(body.ok, true);
		assert.deepEqual(Object.keys(body.data).sort(), ['block', 'name', 'slug', 'warnings']);
		assert.equal(body.data.warnings.length, 1);
		assert.match(body.data.warnings[0], /Skipped the style stub and JS behavior class for "hero"/);
		assert.match(body.data.warnings[0], /static\/\.staticrc/);
		const manifest = JSON.parse(read(themeDir, '.wonderpress/manifest/partials/hero.json'));
		assert.equal(manifest.artifacts.script, undefined, 'the skipped half is not advertised');
		assert.equal(manifest.artifacts.style, undefined);
		assert.ok(exists(themeDir, 'src/partials/class-hero.php'), 'the partial itself was still written');
	} finally {
		fs.removeSync(root);
	}
});

test('CLI: data.warnings is absent when every requested half landed, or none was asked for', () => {
	const withStatic = cliEnv();
	const without = cliEnv({ withStatic: false });
	try {
		const landed = oneEnvelope(withStatic.run(['partial', 'create', '--name', 'Hero', '--js']));
		assert.equal(landed.ok, true);
		assert.equal(landed.data.warnings, undefined);
		assert.ok(exists(withStatic.themeDir, 'static/src/js/components/Hero.js'));

		// No static tree, but nothing delegated was asked for either.
		const quiet = oneEnvelope(without.run(['partial', 'create', '--name', 'Hero', '--no-style']));
		assert.equal(quiet.ok, true);
		assert.equal(quiet.data.warnings, undefined);
	} finally {
		fs.removeSync(withStatic.root);
		fs.removeSync(without.root);
	}
});

test('writePartial returns the warnings it logged; --js --no-template is one too', async () => {
	const { root, themeDir } = cliEnv({ withStatic: false });
	try {
		const skipped = await writePartial(paramsFromFlags({ '--name': 'Hero', '--js': true }), themeDir);
		assert.equal(skipped.warnings.length, 1);
		assert.match(skipped.warnings[0], /Skipped the style stub and JS behavior class/);
		assert.equal(skipped.class.rel, 'src/partials/class-hero.php');

		const noView = await writePartial(paramsFromFlags({ '--name': 'Card', '--js': true, '--no-template': true, '--no-style': true }), themeDir);
		assert.equal(noView.warnings.length, 1);
		assert.match(noView.warnings[0], /Drop --no-template/);

		const clean = await writePartial(paramsFromFlags({ '--name': 'Quote', '--no-style': true }), themeDir);
		assert.deepEqual(clean.warnings, []);
	} finally {
		fs.removeSync(root);
	}
});

test('partial add-js: a skipped JS half fails with the reason in the error, and collects it for the caller', async () => {
	const { root, themeDir, run } = cliEnv({ withStatic: false });
	try {
		run(['partial', 'create', '--name', 'Hero', '--no-style']);
		const result = run(['partial', 'add-js', 'Hero']);
		assert.equal(result.status, 1, result.stdout);
		const body = oneEnvelope(result);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'partial');
		assert.match(body.error.message, /Could not add JS to "Hero": Skipped the JS behavior class for "hero"/);
		assert.match(body.error.message, /static\/\.staticrc/);

		const warnings = [];
		assert.equal(await addScript(themeDir, 'Hero', { warnings }), false);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /Skipped the JS behavior class/);
	} finally {
		fs.removeSync(root);
	}
});

test('MCP: partial_create carries the same warnings field', async () => {
	const { root } = cliEnv({ withStatic: false });
	const cwd = process.cwd();
	const parse = (r) => JSON.parse(r.content[0].text);
	try {
		process.chdir(root);
		const spec = { name: 'Hero', properties: [{ name: 'title', type: 'string' }], js: true };
		const created = parse(await handlers.partial_create({ dir: root, theme: 'smoke', spec }));
		assert.equal(created.ok, true, JSON.stringify(created));
		assert.equal(created.warnings.length, 1);
		assert.match(created.warnings[0], /Skipped the style stub and JS behavior class/);

		const quiet = parse(await handlers.partial_create({ dir: root, theme: 'smoke', spec: { name: 'Card', style: false } }));
		assert.equal(quiet.ok, true, JSON.stringify(quiet));
		assert.equal(quiet.warnings, undefined);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('--no-template: a stray view at the default path is not in the way, a class still is', () => {
	const { root, themeDir, run } = cliEnv();
	try {
		fs.writeFileSync(path.join(themeDir, 'partials/hero.php'), '<?php // hand-written view\n');
		const ok = oneEnvelope(run(['partial', 'create', '--name', 'Hero', '--no-template', '--no-style']));
		assert.equal(ok.ok, true, JSON.stringify(ok));
		assert.equal(read(themeDir, 'partials/hero.php'), '<?php // hand-written view\n', 'not rewritten');

		const refused = oneEnvelope(run(['partial', 'create', '--name', 'Hero', '--no-template', '--no-style']));
		assert.equal(refused.error.code, 'exists');
		assert.match(refused.error.message, /class-hero\.php/);
		assert.doesNotMatch(refused.error.message, /partials\/hero\.php/);
	} finally {
		fs.removeSync(root);
	}
});
