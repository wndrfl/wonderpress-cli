// Partial/block CRUD: the opt-in JS half, retrofitting a block onto an existing
// partial, and the manifest-driven list/remove commands.
//
// Everything here runs against a temp theme directory and calls the
// themeDir-level functions directly, so there is no cwd juggling and no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	listPartials,
	paramsFromFlags,
	paramsFromJson,
	paramsFromManifest,
	removePartial,
	staticArtifacts,
	validateParams,
	writeManifest,
	writePartial,
} from '../src/partial.js';
import { addBlock, listBlocks, removeBlock } from '../src/block.js';

// A theme fixture that also carries a minimal Static Kit tree, so the delegated
// style/script halves actually land instead of being skipped for want of config.
function tmpTheme() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-crud-'));
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	fs.ensureDirSync(path.join(dir, 'static'));
	fs.writeFileSync(path.join(dir, 'static/.staticrc'), JSON.stringify({
		paths: {
			src: { js: 'src/js', scss: 'src/scss', images: 'src/images' },
			dist: { js: 'dist/js', css: 'dist/css', images: 'dist/images' },
		},
	}));
	return dir;
}

// The same theme fixture WITHOUT a Static Kit tree — the common real-world case
// where `component.create` no-ops and nothing delegated can be recorded.
function tmpThemeNoStatic() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-crud-'));
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

function manifestOf(dir, slug) {
	return JSON.parse(fs.readFileSync(path.join(dir, `.wonderpress/manifest/${slug}.json`), 'utf8'));
}

// --- the opt-in JS behavior half ---

test('--js opts in: the JS behavior class is delegated to Static Kit and recorded', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Call_To_Action', '--js': true }), dir);

		assert.ok(fs.existsSync(path.join(dir, 'static/src/js/lib/partials/CallToAction.js')), 'JS behavior class should exist');
		const m = manifestOf(dir, 'call-to-action');
		assert.equal(m.artifacts.script, 'static/src/js/lib/partials/CallToAction.js');
		assert.equal(m.artifacts.style, 'static/src/scss/partials/_call-to-action.scss');
	} finally {
		fs.removeSync(dir);
	}
});

test('the JS half is off by default (a partial has no behavior unless asked)', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);

		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/lib/partials/Hero.js')), 'no JS without --js');
		assert.equal(manifestOf(dir, 'hero').artifacts.script, undefined);
	} finally {
		fs.removeSync(dir);
	}
});

test('--json accepts js (and script as an alias) for the behavior half', () => {
	assert.equal(paramsFromJson(JSON.stringify({ name: 'Hero' })).emit.script, false);
	assert.equal(paramsFromJson(JSON.stringify({ name: 'Hero', js: true })).emit.script, true);
	assert.equal(paramsFromJson(JSON.stringify({ name: 'Hero', script: true })).emit.script, true);
});

test('nothing delegated is advertised when the static-kit component API is unavailable', () => {
	const dir = tmpTheme();
	try {
		const params = paramsFromFlags({ '--name': 'Hero', '--js': true });

		const available = staticArtifacts(params, true);
		assert.deepEqual([available.willEmitStyle, available.willEmitScript], [true, true]);

		const unavailable = staticArtifacts(params, false);
		assert.deepEqual([unavailable.wantsStyle, unavailable.wantsScript], [true, true], 'the intent is still recorded');
		assert.deepEqual([unavailable.willEmitStyle, unavailable.willEmitScript], [false, false]);

		writeManifest(params, dir, { style: unavailable.willEmitStyle, script: unavailable.willEmitScript });
		const m = manifestOf(dir, 'hero');
		assert.equal(m.artifacts.style, undefined, 'never advertise an unwritten artifact');
		assert.equal(m.artifacts.script, undefined);
	} finally {
		fs.removeSync(dir);
	}
});

// --- retrofitting a block onto an existing partial ---

test('paramsFromManifest reconstructs the contract (view derived from artifacts.view)', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'My_Cool_Thing', '--acf': true, '--prop': ['body:string:required'] }), dir);

		const params = paramsFromManifest(manifestOf(dir, 'my-cool-thing'));
		assert.equal(params.class_name, 'My_Cool_Thing');
		assert.equal(params.is_acf_compatible, true);
		assert.equal(params.has_partial_template, true);
		assert.equal(params.partial_template_name, 'my-cool-thing.php');
		assert.deepEqual(params.properties, [{ name: 'body', type: 'string', required: true, description: '' }]);
		assert.equal(params.emit.block, false);
		assert.equal(params.emit.style, true);
	} finally {
		fs.removeSync(dir);
	}
});

test('block create retrofits a block onto an existing partial and updates the manifest', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--prop': ['quote:string:required'] }), dir);
		assert.ok(!fs.existsSync(path.join(dir, 'blocks/testimonial/block.json')), 'no block before the retrofit');

		assert.equal(addBlock(dir, 'Testimonial'), true);

		const block = JSON.parse(fs.readFileSync(path.join(dir, 'blocks/testimonial/block.json'), 'utf8'));
		assert.equal(block.name, 'wonderpress/testimonial');
		assert.equal(block.attributes.quote.type, 'string');

		// A block is only a wrapper: its render delegates back to the partial.
		const render = fs.readFileSync(path.join(dir, 'blocks/testimonial/render.php'), 'utf8');
		assert.match(render, /use Wonderpress\\Partials\\Testimonial;/);
		assert.match(render, /new Testimonial\( \$attributes \)/);

		const m = manifestOf(dir, 'testimonial');
		assert.equal(m.block, 'wonderpress/testimonial');
		assert.equal(m.artifacts.block, 'blocks/testimonial/block.json');
		assert.equal(m.artifacts.render, 'blocks/testimonial/render.php');
	} finally {
		fs.removeSync(dir);
	}
});

test('block create accepts a slug as well as a class name', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Call_To_Action' }), dir);
		assert.equal(addBlock(dir, 'call-to-action'), true);
		assert.equal(manifestOf(dir, 'call-to-action').block, 'wonderpress/call-to-action');
	} finally {
		fs.removeSync(dir);
	}
});

test('block create refuses to invent a partial that does not exist', () => {
	const dir = tmpTheme();
	try {
		assert.equal(addBlock(dir, 'Nope'), false);
		assert.ok(!fs.existsSync(path.join(dir, 'blocks/nope')), 'nothing scaffolded');
	} finally {
		fs.removeSync(dir);
	}
});

test('--block and a later `block create` produce identical output', async () => {
	const flags = { '--name': 'Testimonial', '--acf': true, '--prop': ['quote:string:required', 'featured:boolean'] };
	const t1 = tmpTheme();
	const t2 = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ ...flags, '--block': true }), t1);
		await writePartial(paramsFromFlags(flags), t2);
		assert.equal(addBlock(t2, 'Testimonial'), true);

		for (const rel of ['blocks/testimonial/block.json', 'blocks/testimonial/render.php', '.wonderpress/manifest/testimonial.json']) {
			assert.equal(fs.readFileSync(path.join(t1, rel), 'utf8'), fs.readFileSync(path.join(t2, rel), 'utf8'), rel);
		}
	} finally {
		fs.removeSync(t1);
		fs.removeSync(t2);
	}
});

// --- removal ---

test('partial remove refuses while a block still wraps the partial', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--block': true }), dir);

		assert.equal(removePartial(dir, 'Testimonial'), false);
		assert.ok(fs.existsSync(path.join(dir, 'src/partials/class-testimonial.php')), 'the partial survives the refusal');
		assert.ok(fs.existsSync(path.join(dir, 'blocks/testimonial/block.json')));
		assert.ok(fs.existsSync(path.join(dir, '.wonderpress/manifest/testimonial.json')));
	} finally {
		fs.removeSync(dir);
	}
});

test('partial remove --with-block cascades over every recorded artifact', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--block': true, '--js': true }), dir);
		for (const rel of ['src/partials/class-testimonial.php', 'partials/testimonial.php', 'static/src/scss/partials/_testimonial.scss', 'static/src/js/lib/partials/Testimonial.js']) {
			assert.ok(fs.existsSync(path.join(dir, rel)), `${rel} should exist first`);
		}

		assert.equal(removePartial(dir, 'Testimonial', { withBlock: true }), true);

		for (const rel of ['src/partials/class-testimonial.php', 'partials/testimonial.php', 'static/src/scss/partials/_testimonial.scss', 'static/src/js/lib/partials/Testimonial.js', 'blocks/testimonial', '.wonderpress/manifest/testimonial.json']) {
			assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} should be gone`);
		}
	} finally {
		fs.removeSync(dir);
	}
});

test('partial remove errors on an unknown name', () => {
	const dir = tmpTheme();
	try {
		assert.equal(removePartial(dir, 'Nope'), false);
	} finally {
		fs.removeSync(dir);
	}
});

test('block remove leaves the partial intact and strips the block from the manifest', async () => {
	const dir = tmpTheme();
	const plain = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--block': true, '--prop': ['quote:string:required'] }), dir);
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--prop': ['quote:string:required'] }), plain);

		assert.equal(removeBlock(dir, 'Testimonial'), true);

		assert.ok(!fs.existsSync(path.join(dir, 'blocks/testimonial')), 'the block directory is gone');
		assert.ok(fs.existsSync(path.join(dir, 'src/partials/class-testimonial.php')), 'the partial is untouched');
		assert.ok(fs.existsSync(path.join(dir, 'partials/testimonial.php')));

		// Unwrapping must leave exactly the manifest a never-blocked partial has.
		assert.equal(
			fs.readFileSync(path.join(dir, '.wonderpress/manifest/testimonial.json'), 'utf8'),
			fs.readFileSync(path.join(plain, '.wonderpress/manifest/testimonial.json'), 'utf8')
		);

		// ...and it is idempotent-friendly: a second removal is a clear no.
		assert.equal(removeBlock(dir, 'Testimonial'), false);
	} finally {
		fs.removeSync(dir);
		fs.removeSync(plain);
	}
});

// --- listing (the manifest is the index) ---

test('listPartials and listBlocks read the manifest index', async () => {
	const dir = tmpTheme();
	try {
		assert.deepEqual(listPartials(dir), []);
		assert.deepEqual(listBlocks(dir), []);

		await writePartial(paramsFromFlags({ '--name': 'Hero', '--block': true }), dir);
		await writePartial(paramsFromFlags({ '--name': 'Call_To_Action' }), dir);

		assert.deepEqual(listPartials(dir), [
			{ name: 'Call_To_Action', slug: 'call-to-action', block: null },
			{ name: 'Hero', slug: 'hero', block: 'wonderpress/hero' },
		]);
		assert.deepEqual(listBlocks(dir), [
			{ block: 'wonderpress/hero', partial: 'Hero', slug: 'hero' },
		]);
	} finally {
		fs.removeSync(dir);
	}
});

// --- the manifest never lies: every artifact it names exists ---

test('every artifact the manifest advertises exists on disk', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Call_To_Action', '--block': true, '--js': true }), dir);

		const m = manifestOf(dir, 'call-to-action');
		// The delegated halves are the point of the check, so make sure they were
		// in fact advertised — otherwise this passes vacuously.
		assert.ok(m.artifacts.style && m.artifacts.script, 'a real static tree yields both delegated halves');
		for (const [key, rel] of Object.entries(m.artifacts)) {
			assert.ok(fs.existsSync(path.join(dir, rel)), `artifacts.${key} (${rel}) should exist`);
		}
	} finally {
		fs.removeSync(dir);
	}
});

test('without a static tree the manifest records no delegated artifacts', async () => {
	const dir = tmpThemeNoStatic();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Call_To_Action', '--js': true }), dir);

		assert.ok(!fs.existsSync(path.join(dir, 'static')), 'nothing was written into a static tree that does not exist');

		const m = manifestOf(dir, 'call-to-action');
		assert.equal(m.artifacts.style, undefined, 'never advertise a style stub that was not written');
		assert.equal(m.artifacts.script, undefined, 'never advertise a behavior class that was not written');
		for (const [key, rel] of Object.entries(m.artifacts)) {
			assert.ok(fs.existsSync(path.join(dir, rel)), `artifacts.${key} (${rel}) should exist`);
		}
	} finally {
		fs.removeSync(dir);
	}
});

test('--js with --no-template records no script artifact', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--js': true, '--no-template': true }), dir);

		const m = manifestOf(dir, 'hero');
		assert.equal(m.artifacts.view, undefined, 'no view was requested');
		assert.equal(m.artifacts.script, undefined, 'a behavior class needs a view to attach to');
		assert.equal(m.artifacts.style, undefined);
		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/lib/partials/Hero.js')), 'nothing delegated was written');
	} finally {
		fs.removeSync(dir);
	}
});

// --- containment: a manifest is a file on disk, not a trusted delete list ---

test('removePartial refuses an artifact path that escapes the theme', async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-outside-'));
	const dir = path.join(parent, 'theme');
	const bystander = path.join(parent, 'outside.txt');
	try {
		fs.ensureDirSync(path.join(dir, 'src/partials'));
		fs.ensureDirSync(path.join(dir, 'partials'));
		fs.writeFileSync(bystander, 'do not delete me');

		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);

		// Poison the index the way a crafted or corrupted manifest would.
		const file = path.join(dir, '.wonderpress/manifest/hero.json');
		const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
		manifest.artifacts.style = '../outside.txt';
		fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');

		assert.equal(removePartial(dir, 'Hero'), true, 'one bad entry does not abort the removal');

		assert.ok(fs.existsSync(bystander), 'a file outside the theme must survive');
		assert.equal(fs.readFileSync(bystander, 'utf8'), 'do not delete me');
		assert.ok(!fs.existsSync(path.join(dir, 'src/partials/class-hero.php')), 'the in-theme artifacts still go');
		assert.ok(!fs.existsSync(file), 'the manifest still goes');
	} finally {
		fs.removeSync(parent);
	}
});

test('removePartial refuses a name that is not a safe slug', () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-outside-'));
	const dir = path.join(parent, 'theme');
	const bystander = path.join(parent, 'outside.txt');
	try {
		fs.ensureDirSync(dir);
		fs.writeFileSync(bystander, 'do not delete me');

		assert.equal(removePartial(dir, '../../../foo'), false);
		assert.ok(fs.existsSync(bystander));
	} finally {
		fs.removeSync(parent);
	}
});

test('a malformed manifest is skipped by list and refused by remove', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);
		fs.writeFileSync(path.join(dir, '.wonderpress/manifest/junk.json'), '[]\n');

		assert.deepEqual(listPartials(dir), [{ name: 'Hero', slug: 'hero', block: null }], 'junk rows never reach the table');
		assert.deepEqual(listBlocks(dir), []);
		assert.equal(removePartial(dir, 'junk'), false);
		assert.equal(addBlock(dir, 'junk'), false);
		assert.equal(removeBlock(dir, 'junk'), false);
	} finally {
		fs.removeSync(dir);
	}
});

// --- param validation ---

test('a block without the manifest is refused: the index is what makes it manageable', () => {
	assert.throws(
		() => validateParams(paramsFromFlags({ '--name': 'Hero', '--block': true, '--no-manifest': true })),
		/A block requires the manifest/
	);
	assert.throws(
		() => validateParams(paramsFromJson(JSON.stringify({ name: 'Hero', block: true, manifest: false }))),
		/A block requires the manifest/
	);

	// Either half alone is still fine.
	validateParams(paramsFromFlags({ '--name': 'Hero', '--no-manifest': true }));
	validateParams(paramsFromFlags({ '--name': 'Hero', '--block': true }));
});
