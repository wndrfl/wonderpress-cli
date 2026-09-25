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
	addScript,
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

// The theme directory is deliberately given a STABLE name inside the random
// temp parent. The block namespace derives from the theme slug when nothing
// else records one, so a random basename made emitted block names depend on
// mkdtemp — which passed on macOS (mixed-case suffix, rejected as a namespace)
// and failed on Linux (lowercase, accepted). A fixture should not be the thing
// that decides what a block is called.
// A theme fixture that also carries a minimal Static Kit tree, so the delegated
// style/script halves actually land instead of being skipped for want of config.
function tmpTheme() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-crud-')), 'wonderpress');
	fs.ensureDirSync(dir);
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
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-crud-')), 'wonderpress');
	fs.ensureDirSync(dir);
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

function manifestOf(dir, slug) {
	return JSON.parse(fs.readFileSync(path.join(dir, `.wonderpress/manifest/partials/${slug}.json`), 'utf8'));
}

// --- the opt-in JS behavior half ---

test('--js opts in: the JS behavior class is delegated to Static Kit and recorded', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Call_To_Action', '--js': true }), dir);

		assert.ok(fs.existsSync(path.join(dir, 'static/src/js/components/CallToAction.js')), 'JS behavior class should exist');
		const m = manifestOf(dir, 'call-to-action');
		assert.equal(m.artifacts.script, 'static/src/js/components/CallToAction.js');
		assert.equal(m.artifacts.style, 'static/src/scss/components/_call-to-action.scss');
	} finally {
		fs.removeSync(dir);
	}
});

test('the JS half is off by default (a partial has no behavior unless asked)', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);

		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/components/Hero.js')), 'no JS without --js');
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

		// A block is only a wrapper: its render delegates back to the partial,
		// inside an element carrying WordPress's generated block attributes.
		const render = fs.readFileSync(path.join(dir, 'blocks/testimonial/render.php'), 'utf8');
		assert.match(render, /use Wonderpress\\Partials\\Testimonial;/);
		assert.match(render, /new Testimonial\( \$attributes \)/);
		assert.match(render, /get_block_wrapper_attributes\(\)/);

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

		for (const rel of ['blocks/testimonial/block.json', 'blocks/testimonial/render.php', '.wonderpress/manifest/partials/testimonial.json']) {
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

		assert.equal(await removePartial(dir, 'Testimonial'), false);
		assert.ok(fs.existsSync(path.join(dir, 'src/partials/class-testimonial.php')), 'the partial survives the refusal');
		assert.ok(fs.existsSync(path.join(dir, 'blocks/testimonial/block.json')));
		assert.ok(fs.existsSync(path.join(dir, '.wonderpress/manifest/partials/testimonial.json')));
	} finally {
		fs.removeSync(dir);
	}
});

test('partial remove --with-block cascades over every recorded artifact', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--block': true, '--js': true }), dir);
		for (const rel of ['src/partials/class-testimonial.php', 'partials/testimonial.php', 'static/src/scss/components/_testimonial.scss', 'static/src/js/components/Testimonial.js']) {
			assert.ok(fs.existsSync(path.join(dir, rel)), `${rel} should exist first`);
		}

		assert.equal(await removePartial(dir, 'Testimonial', { withBlock: true }), true);

		for (const rel of ['src/partials/class-testimonial.php', 'partials/testimonial.php', 'static/src/scss/components/_testimonial.scss', 'static/src/js/components/Testimonial.js', 'blocks/testimonial', '.wonderpress/manifest/partials/testimonial.json']) {
			assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} should be gone`);
		}
	} finally {
		fs.removeSync(dir);
	}
});

test('partial remove deletes static files recorded at the 3.0 layout', async () => {
	const dir = tmpTheme();
	try {
		const style = 'static/src/scss/partials/_hero.scss';
		const script = 'static/src/js/lib/partials/Hero.js';
		const classRel = 'src/partials/class-hero.php';
		const viewRel = 'partials/hero.php';
		for (const rel of [style, script, classRel, viewRel]) {
			const abs = path.join(dir, rel);
			fs.ensureDirSync(path.dirname(abs));
			fs.writeFileSync(abs, 'legacy\n');
		}
		fs.ensureDirSync(path.join(dir, '.wonderpress/manifest/partials'));
		fs.writeFileSync(path.join(dir, '.wonderpress/manifest/partials/hero.json'), JSON.stringify({
			name: 'Hero',
			slug: 'hero',
			acf_compatible: false,
			properties: [],
			artifacts: { class: classRel, view: viewRel, style, script },
		}, null, 2) + '\n');

		assert.equal(await removePartial(dir, 'Hero'), true);

		for (const rel of [style, script, classRel, viewRel, '.wonderpress/manifest/partials/hero.json']) {
			assert.ok(!fs.existsSync(path.join(dir, rel)), `${rel} should be gone`);
		}
	} finally {
		fs.removeSync(dir);
	}
});

test('partial remove errors on an unknown name', async () => {
	const dir = tmpTheme();
	try {
		assert.equal(await removePartial(dir, 'Nope'), false);
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
			fs.readFileSync(path.join(dir, '.wonderpress/manifest/partials/testimonial.json'), 'utf8'),
			fs.readFileSync(path.join(plain, '.wonderpress/manifest/partials/testimonial.json'), 'utf8')
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
			{ block: 'wonderpress/hero', partial: 'Hero', slug: 'hero', managed: true },
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
		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/components/Hero.js')), 'nothing delegated was written');
	} finally {
		fs.removeSync(dir);
	}
});

// --- retrofitting JS onto an existing partial ---

test('partial add-js scaffolds a behavior class and records it', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);
		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/components/Hero.js')));

		assert.equal(await addScript(dir, 'Hero'), true);

		assert.ok(fs.existsSync(path.join(dir, 'static/src/js/components/Hero.js')));
		assert.equal(manifestOf(dir, 'hero').artifacts.script, 'static/src/js/components/Hero.js');
	} finally {
		fs.removeSync(dir);
	}
});

test('partial add-js does not clobber an existing SCSS stub', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);
		const stylePath = path.join(dir, 'static/src/scss/components/_hero.scss');
		const original = fs.readFileSync(stylePath, 'utf8');
		fs.writeFileSync(stylePath, original + '\n/* keep me */\n');

		assert.equal(await addScript(dir, 'Hero'), true);

		assert.match(fs.readFileSync(stylePath, 'utf8'), /keep me/);
		assert.equal(manifestOf(dir, 'hero').artifacts.style, 'static/src/scss/components/_hero.scss');
	} finally {
		fs.removeSync(dir);
	}
});

test('partial add-js is idempotent and does not overwrite custom JS', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);
		assert.equal(await addScript(dir, 'Hero'), true);

		const jsPath = path.join(dir, 'static/src/js/components/Hero.js');
		fs.writeFileSync(jsPath, '// custom behavior\n');

		assert.equal(await addScript(dir, 'Hero'), true);
		assert.equal(fs.readFileSync(jsPath, 'utf8'), '// custom behavior\n');
		assert.equal(manifestOf(dir, 'hero').artifacts.script, 'static/src/js/components/Hero.js');
	} finally {
		fs.removeSync(dir);
	}
});

test('partial add-js records an existing unindexed JS file without rewriting it', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);
		const jsPath = path.join(dir, 'static/src/js/components/Hero.js');
		fs.ensureDirSync(path.dirname(jsPath));
		fs.writeFileSync(jsPath, '// dropped by hand\n');

		assert.equal(await addScript(dir, 'Hero'), true);
		assert.equal(fs.readFileSync(jsPath, 'utf8'), '// dropped by hand\n');
		assert.equal(manifestOf(dir, 'hero').artifacts.script, 'static/src/js/components/Hero.js');
	} finally {
		fs.removeSync(dir);
	}
});

test('--js and a later add-js produce the same script path and file', async () => {
	const t1 = tmpTheme();
	const t2 = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--js': true }), t1);
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), t2);
		assert.equal(await addScript(t2, 'Hero'), true);

		const rel = 'static/src/js/components/Hero.js';
		assert.equal(fs.readFileSync(path.join(t1, rel), 'utf8'), fs.readFileSync(path.join(t2, rel), 'utf8'));
		assert.equal(manifestOf(t1, 'hero').artifacts.script, manifestOf(t2, 'hero').artifacts.script);
	} finally {
		fs.removeSync(t1);
		fs.removeSync(t2);
	}
});

test('partial add-js refuses a missing view', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--no-template': true }), dir);
		assert.equal(await addScript(dir, 'Hero'), false);
		assert.equal(manifestOf(dir, 'hero').artifacts.script, undefined);
		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/components/Hero.js')));
	} finally {
		fs.removeSync(dir);
	}
});

test('partial add-js without a static tree records no script', async () => {
	const dir = tmpThemeNoStatic();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);
		assert.equal(await addScript(dir, 'Hero'), false);
		assert.equal(manifestOf(dir, 'hero').artifacts.script, undefined);
	} finally {
		fs.removeSync(dir);
	}
});

test('partial add-js refuses to invent a partial that does not exist', async () => {
	const dir = tmpTheme();
	try {
		assert.equal(await addScript(dir, 'Nope'), false);
		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/components/Nope.js')));
	} finally {
		fs.removeSync(dir);
	}
});

test('partial add-js accepts a slug as well as a class name', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Call_To_Action' }), dir);
		assert.equal(await addScript(dir, 'call-to-action'), true);
		assert.equal(manifestOf(dir, 'call-to-action').artifacts.script, 'static/src/js/components/CallToAction.js');
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
		const file = path.join(dir, '.wonderpress/manifest/partials/hero.json');
		const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
		manifest.artifacts.style = '../outside.txt';
		fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');

		assert.equal(await removePartial(dir, 'Hero'), true, 'one bad entry does not abort the removal');

		assert.ok(fs.existsSync(bystander), 'a file outside the theme must survive');
		assert.equal(fs.readFileSync(bystander, 'utf8'), 'do not delete me');
		assert.ok(!fs.existsSync(path.join(dir, 'src/partials/class-hero.php')), 'the in-theme artifacts still go');
		assert.ok(!fs.existsSync(file), 'the manifest still goes');
	} finally {
		fs.removeSync(parent);
	}
});

test('removePartial refuses a name that is not a safe slug', async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-outside-'));
	const dir = path.join(parent, 'theme');
	const bystander = path.join(parent, 'outside.txt');
	try {
		fs.ensureDirSync(dir);
		fs.writeFileSync(bystander, 'do not delete me');

		assert.equal(await removePartial(dir, '../../../foo'), false);
		assert.ok(fs.existsSync(bystander));
	} finally {
		fs.removeSync(parent);
	}
});

test('a malformed manifest is skipped by list and refused by remove', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), dir);
		fs.writeFileSync(path.join(dir, '.wonderpress/manifest/partials/junk.json'), '[]\n');

		assert.deepEqual(listPartials(dir), [{ name: 'Hero', slug: 'hero', block: null }], 'junk rows never reach the table');
		assert.deepEqual(listBlocks(dir), []);
		assert.equal(await removePartial(dir, 'junk'), false);
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

test('ACF without the manifest is refused: core reads the manifest to register the group', () => {
	assert.throws(
		() => validateParams(paramsFromFlags({ '--name': 'Hero', '--acf': true, '--no-manifest': true })),
		/ACF compatibility requires the manifest/
	);
	assert.throws(
		() => validateParams(paramsFromJson(JSON.stringify({ name: 'Hero', acf_compatible: true, manifest: false }))),
		/ACF compatibility requires the manifest/
	);

	validateParams(paramsFromFlags({ '--name': 'Hero', '--acf': true }));
});

test('a repeater without sub-fields is refused', () => {
	assert.throws(
		() => validateParams(paramsFromFlags({ '--name': 'Testimonials', '--prop': ['items:repeater'] })),
		/must declare at least one sub-field/
	);
});

test('--sub attaches rows to a repeater; a bare --sub on a non-repeater is refused', () => {
	const p = paramsFromFlags({
		'--name': 'Testimonials',
		'--prop': ['items:repeater'],
		'--sub': ['items:quote:string:required', 'items:photo:image'],
	});
	assert.deepEqual(p.properties[0].properties, [
		{ name: 'quote', type: 'string', required: true, description: '' },
		{ name: 'photo', type: 'image', required: false, description: '' },
	]);
	validateParams(p);

	assert.throws(
		() => paramsFromFlags({
			'--name': 'Hero',
			'--prop': ['headline:string'],
			'--sub': ['headline:quote:string'],
		}),
		/not repeater/
	);
});

// --- blocks the CLI did not write ---
//
// WordPress registers every `blocks/<slug>/block.json` it finds, so a
// hand-made block is a real, working block with no manifest behind it. `list`
// must not under-report the theme just because the manifest cannot see it.

function handMadeBlock(dir, slug, name) {
	fs.ensureDirSync(path.join(dir, 'blocks', slug));
	fs.writeFileSync(
		path.join(dir, 'blocks', slug, 'block.json'),
		JSON.stringify({ apiVersion: 3, name, title: slug, category: 'wonderpress' })
	);
}

test('listBlocks reports hand-made blocks, marked as unmanaged', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--block': true }), dir);
		handMadeBlock(dir, 'handmade', 'wonderpress/handmade');

		assert.deepEqual(listBlocks(dir), [
			{ block: 'wonderpress/handmade', partial: null, slug: 'handmade', managed: false },
			{ block: 'wonderpress/hero', partial: 'Hero', slug: 'hero', managed: true },
		]);
	} finally {
		fs.removeSync(dir);
	}
});

test('a block the CLI wrote is never double-counted as unmanaged', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--block': true }), dir);
		const rows = listBlocks(dir);
		assert.equal(rows.length, 1, 'the manifest row and the directory are the same block');
		assert.equal(rows[0].managed, true);
	} finally {
		fs.removeSync(dir);
	}
});

test('a block directory without block.json is not a block', async () => {
	const dir = tmpTheme();
	try {
		fs.ensureDirSync(path.join(dir, 'blocks/not-a-block'));
		fs.writeFileSync(path.join(dir, 'blocks/not-a-block/notes.txt'), 'scratch');
		assert.deepEqual(listBlocks(dir), [], 'WordPress would ignore it, and so do we');
	} finally {
		fs.removeSync(dir);
	}
});

test('unreadable block.json is skipped rather than crashing the listing', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--block': true }), dir);
		fs.ensureDirSync(path.join(dir, 'blocks/broken'));
		fs.writeFileSync(path.join(dir, 'blocks/broken/block.json'), '{ not json');

		const rows = listBlocks(dir);
		assert.deepEqual(rows.map((r) => r.slug), ['hero'], 'the good row still lists');
	} finally {
		fs.removeSync(dir);
	}
});
