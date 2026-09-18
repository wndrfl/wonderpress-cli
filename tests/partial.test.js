import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	paramsFromFlags,
	paramsFromJson,
	writePartial,
	validateParams,
	resolveNamespace,
	seedFromFlags,
	mergeWizardAnswers,
} from '../src/partial.js';

// The theme directory is deliberately given a STABLE name inside the random
// temp parent. The block namespace derives from the theme slug when nothing
// else records one, so a random basename made emitted block names depend on
// mkdtemp — which passed on macOS (mixed-case suffix, rejected as a namespace)
// and failed on Linux (lowercase, accepted). A fixture should not be the thing
// that decides what a block is called.
function tmpTheme() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-partial-')), 'wonderpress');
	fs.ensureDirSync(dir);
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

test('paramsFromFlags maps flags to params', () => {
	const p = paramsFromFlags({ '--name': 'Testimonial', '--acf': true, '--prop': ['quote:string:required', 'company:string'] });
	assert.equal(p.class_name, 'Testimonial');
	assert.equal(p.is_acf_compatible, true);
	assert.equal(p.has_partial_template, true);
	assert.equal(p.partial_template_name, 'testimonial.php');
	assert.deepEqual(p.properties, [
		{ name: 'quote', type: 'string', required: true, description: '' },
		{ name: 'company', type: 'string', required: false, description: '' },
	]);
});

test('paramsFromJson maps the canonical contract', () => {
	const p = paramsFromJson(JSON.stringify({ name: 'Hero', acf_compatible: false, template: true, properties: [{ name: 'title', type: 'string', required: true }] }));
	assert.equal(p.class_name, 'Hero');
	assert.equal(p.is_acf_compatible, false);
	assert.equal(p.properties[0].required, true);
});

test('writePartial: flag form and json form are byte-identical', async () => {
	const spec = {
		name: 'Testimonial', acf_compatible: true, template: true, properties: [
			{ name: 'quote', type: 'string', required: true },
			{ name: 'author', type: 'string', required: true },
			{ name: 'company', type: 'string', required: false },
		],
	};
	const flags = { '--name': 'Testimonial', '--acf': true, '--prop': ['quote:string:required', 'author:string:required', 'company:string'] };

	const t1 = tmpTheme();
	const t2 = tmpTheme();
	try {
		const pFlags = paramsFromFlags(flags);
		const pJson = paramsFromJson(JSON.stringify(spec));
		validateParams(pFlags);
		validateParams(pJson);
		await writePartial(pFlags, t1);
		await writePartial(pJson, t2);

		const a = fs.readFileSync(path.join(t1, 'src/partials/class-testimonial.php'), 'utf8');
		const b = fs.readFileSync(path.join(t2, 'src/partials/class-testimonial.php'), 'utf8');
		assert.equal(a, b);

		// $_properties must be unescaped (no leftover heredoc \$)
		assert.match(a, /protected static \$_properties/);
		assert.doesNotMatch(a, /\\\$/);

		// the view template is written too
		assert.ok(fs.existsSync(path.join(t1, 'partials/testimonial.php')));
	} finally {
		fs.removeSync(t1);
		fs.removeSync(t2);
	}
});

test('validateParams rejects a bad class name', () => {
	assert.throws(() => validateParams({ class_name: 'bad-name', has_partial_template: false, properties: [] }), /Invalid class name/);
});

// --- spine emission (manifest always; block opt-in; style delegated) ---

test('a partial is not a block: no block.json/render.php by default', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--prop': ['quote:string:required'] }), dir);
		assert.ok(!fs.existsSync(path.join(dir, 'blocks/testimonial/block.json')), 'no block.json without --block');
		assert.ok(!fs.existsSync(path.join(dir, 'blocks/testimonial/render.php')), 'no render.php without --block');
		// the manifest is still written, and does not advertise a block.
		const m = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/testimonial.json'), 'utf8'));
		assert.equal(m.block, undefined, 'manifest must not name a block that was not emitted');
		assert.equal(m.artifacts.block, undefined);
		assert.equal(m.artifacts.render, undefined);
	} finally {
		fs.removeSync(dir);
	}
});

test('--block opts in: block.json (with render binding) + render.php delegate to the partial', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Testimonial', '--block': true, '--prop': ['quote:string:required', 'featured:boolean'] }), dir);
		const block = JSON.parse(fs.readFileSync(path.join(dir, 'blocks/testimonial/block.json'), 'utf8'));
		assert.equal(block.name, 'wonderpress/testimonial');
		assert.equal(block.title, 'Testimonial');
		assert.equal(block.attributes.quote.type, 'string');
		assert.equal(block.attributes.featured.type, 'boolean');
		assert.equal(block.render, 'file:./render.php');

		const render = fs.readFileSync(path.join(dir, 'blocks/testimonial/render.php'), 'utf8');
		assert.match(render, /use Wonderpress\\Partials\\Testimonial;/);
		assert.match(render, /new Testimonial\( \$attributes \)/);

		// The wrapper is what makes the output a block WordPress can recognise
		// and target — without it there is no wp-block-* class on the markup.
		assert.match(render, /get_block_wrapper_attributes\(\)/);
	} finally {
		fs.removeSync(dir);
	}
});

test('writePartial emits an agent manifest mirroring properties + artifact paths', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'My_Cool_Thing', '--block': true, '--acf': true, '--prop': ['body:string:required'] }), dir);
		const m = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/my-cool-thing.json'), 'utf8'));
		assert.equal(m.name, 'My_Cool_Thing');
		assert.equal(m.slug, 'my-cool-thing');
		assert.equal(m.block, 'wonderpress/my-cool-thing');
		assert.equal(m.acf_compatible, true);
		assert.deepEqual(m.properties, [{ name: 'body', type: 'string', required: true, description: '' }]);
		assert.equal(m.artifacts.class, 'src/partials/class-my-cool-thing.php');
		assert.equal(m.artifacts.block, 'blocks/my-cool-thing/block.json');
		assert.equal(m.artifacts.render, 'blocks/my-cool-thing/render.php');
	} finally {
		fs.removeSync(dir);
	}
});

test('emit opt-outs: default suppresses block, --no-manifest suppresses manifest (class still written)', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Solo', '--no-manifest': true }), dir);
		assert.ok(!fs.existsSync(path.join(dir, 'blocks/solo/block.json')));
		assert.ok(!fs.existsSync(path.join(dir, '.wonderpress/manifest/solo.json')));
		assert.ok(fs.existsSync(path.join(dir, 'src/partials/class-solo.php')));
	} finally {
		fs.removeSync(dir);
	}
});

test('block + manifest are identical across flag and json paths', async () => {
	const spec = {
		name: 'Testimonial', acf_compatible: true, template: true, block: true, properties: [
			{ name: 'quote', type: 'string', required: true },
			{ name: 'featured', type: 'boolean', required: false },
		],
	};
	const flags = { '--name': 'Testimonial', '--block': true, '--acf': true, '--prop': ['quote:string:required', 'featured:boolean'] };
	const t1 = tmpTheme();
	const t2 = tmpTheme();
	try {
		await writePartial(paramsFromFlags(flags), t1);
		await writePartial(paramsFromJson(JSON.stringify(spec)), t2);
		for (const rel of ['blocks/testimonial/block.json', 'blocks/testimonial/render.php', '.wonderpress/manifest/testimonial.json']) {
			assert.equal(fs.readFileSync(path.join(t1, rel), 'utf8'), fs.readFileSync(path.join(t2, rel), 'utf8'), rel);
		}
	} finally {
		fs.removeSync(t1);
		fs.removeSync(t2);
	}
});

// ── Namespace resolution ────────────────────────────────────────────────────
//
// A block's namespace is written into the client's content as
// `<!-- wp:acme/testimonial -->`, so it belongs to the project and must never
// drift once chosen. These cover the precedence that guarantees it.

function tmpProject(themeSlug, rc) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-ns-'));
	const themeDir = path.join(root, 'wp-content/themes', themeSlug);
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	if (rc !== undefined) {
		fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify(rc));
	}
	return { root, themeDir };
}

test('namespace: .wonderpressrc wins over everything', () => {
	const { root, themeDir } = tmpProject('some-theme', { namespace: 'acme' });
	try {
		assert.equal(resolveNamespace(themeDir, root), 'acme');
	} finally {
		fs.removeSync(root);
	}
});

test('namespace: an existing project keeps the namespace its blocks already use', async () => {
	// The upgrade path that matters. A project created before this setting has
	// `wonderpress/*` blocks placed in content; resolving from the theme slug
	// would re-namespace every NEW block and split the project in two.
	const { root, themeDir } = tmpProject('acme', {});
	try {
		await writePartial(
			{ ...paramsFromFlags({ '--name': 'Legacy', '--block': true }), namespace: 'wonderpress' },
			themeDir
		);
		assert.equal(resolveNamespace(themeDir, root), 'wonderpress');
	} finally {
		fs.removeSync(root);
	}
});

test('namespace: a fresh project names itself after its theme', () => {
	const { root, themeDir } = tmpProject('acme', {});
	try {
		assert.equal(resolveNamespace(themeDir, root), 'acme');
	} finally {
		fs.removeSync(root);
	}
});

test('namespace: an unusable theme slug falls back rather than emitting an invalid block name', () => {
	// mkdtemp suffixes are mixed-case, which is not a legal block namespace.
	const { root, themeDir } = tmpProject('Not_A_Slug', {});
	try {
		assert.equal(resolveNamespace(themeDir, root), 'wonderpress');
	} finally {
		fs.removeSync(root);
	}
});

test('namespace: it reaches block.json, its category, and the manifest together', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(
			{ ...paramsFromFlags({ '--name': 'Testimonial', '--block': true }), namespace: 'acme' },
			dir
		);
		const block = JSON.parse(fs.readFileSync(path.join(dir, 'blocks/testimonial/block.json'), 'utf8'));
		assert.equal(block.name, 'acme/testimonial');
		assert.equal(block.category, 'acme', 'the inserter groups a project under the project');

		const m = JSON.parse(fs.readFileSync(path.join(dir, '.wonderpress/manifest/testimonial.json'), 'utf8'));
		assert.equal(m.block, 'acme/testimonial', 'the manifest records it, so it can be read back');
	} finally {
		fs.removeSync(dir);
	}
});

test('namespace: a writer called without one resolves it, rather than defaulting to wonderpress', async () => {
	// The regression behind the CI failure. writeBlock/writeManifest used to fall
	// straight back to LEGACY_NAMESPACE when params.namespace was unset, so any
	// caller that forgot would quietly write `wonderpress/hero` into a project
	// whose blocks are `acme/hero` — splitting the namespace of live content,
	// which is the one failure this machinery exists to prevent.
	const { root, themeDir } = tmpProject('acme', {});
	try {
		const params = paramsFromFlags({ '--name': 'Hero', '--block': true });
		assert.equal(params.namespace, undefined, 'the writer is being called cold, on purpose');

		await writePartial(params, themeDir);

		const block = JSON.parse(fs.readFileSync(path.join(themeDir, 'blocks/hero/block.json'), 'utf8'));
		assert.equal(block.name, 'acme/hero');
		assert.equal(block.category, 'acme');

		const m = JSON.parse(fs.readFileSync(path.join(themeDir, '.wonderpress/manifest/hero.json'), 'utf8'));
		assert.equal(m.block, 'acme/hero', 'block.json and the manifest must never disagree');
	} finally {
		fs.removeSync(root);
	}
});

test('namespace: an emitted block never inherits the temp/parent directory name', async () => {
	// Guards the fixture shape itself: the theme slug decides the namespace, so a
	// randomly-named theme directory made emitted block names platform-dependent
	// (lowercase mkdtemp suffixes on Linux were accepted as namespaces, mixed-case
	// ones on macOS were not). Any fixture must pin the theme's own name.
	const dir = tmpTheme();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--block': true }), dir);
		const block = JSON.parse(fs.readFileSync(path.join(dir, 'blocks/hero/block.json'), 'utf8'));
		assert.equal(block.name, 'wonderpress/hero');
		assert.doesNotMatch(block.name, /wp-partial-/, 'the temp directory must never leak into a block name');
	} finally {
		fs.removeSync(dir);
	}
});

test('a block tolerates a partial that cannot render yet', async () => {
	// Found by clicking, not by a test: a partial throws when a required
	// property is missing, and a freshly inserted block has no values at all.
	// Left to throw, the editor shows "Error loading block" before the author
	// can type anything — so a required property made a block unusable.
	const dir = tmpTheme();
	try {
		await writePartial(
			paramsFromFlags({ '--name': 'Pull_Quote', '--block': true, '--prop': ['quote:string:required'] }),
			dir
		);
		const render = fs.readFileSync(path.join(dir, 'blocks/pull-quote/render.php'), 'utf8');

		assert.match(render, /try \{/, 'the render must not let the partial throw out of it');
		assert.match(render, /catch \( \\Throwable \$e \)/);

		// The two halves of the recovery, which differ on purpose.
		assert.match(render, /REST_REQUEST/, 'the editor is told what is missing');
		assert.match(render, /\$e->getMessage\(\)/);
		assert.match(render, /return;/, 'the front end renders nothing rather than fataling the page');
	} finally {
		fs.removeSync(dir);
	}
});

test('the render docblock names the project namespace, not the tool', async () => {
	const dir = tmpTheme();
	try {
		await writePartial(
			{ ...paramsFromFlags({ '--name': 'Hero', '--block': true }), namespace: 'acme' },
			dir
		);
		const render = fs.readFileSync(path.join(dir, 'blocks/hero/render.php'), 'utf8');
		assert.match(render, /acme\/hero/);
		assert.doesNotMatch(render, /wonderpress\/hero/, 'stale since blocks became project-namespaced');
	} finally {
		fs.removeSync(dir);
	}
});

// ── The wizard does not re-ask what the flags already said ──────────────────
//
// `partial create Hero --block` used to fall through to the wizard, which asked
// for the name that had just been typed and then asked whether to make a block
// — defaulting to No. Answering out of habit threw away what had been
// explicitly requested.

test('a flag marks its question as already answered', () => {
	const seeded = seedFromFlags({ '--block': true, '--js': true });
	assert.equal(seeded.emit_block, true);
	assert.equal(seeded.emit_script, true);
	assert.equal(seeded.is_acf_compatible, undefined, 'unflagged questions are still worth asking');
});

test('--no-template seeds FALSE, which is an answer rather than a silence', () => {
	// The bug `??` exists to avoid: `||` would treat this as unanswered and
	// hand back the default of true, creating the template that was refused.
	assert.equal(seedFromFlags({ '--no-template': true }).has_partial_template, false);
});

test('a skipped question falls back to its flag', () => {
	const params = mergeWizardAnswers({ class_name: 'Hero' }, { '--block': true });
	assert.equal(params.emit.block, true, 'the block asked for on the command line is emitted');
	assert.equal(params.class_name, 'Hero');
});

test('an answered question beats the flag that seeded it', () => {
	const params = mergeWizardAnswers(
		{ class_name: 'Hero', emit_block: false },
		{ '--block': true }
	);
	assert.equal(params.emit.block, false, 'what the wizard was told wins');
});

test('--no-template survives the merge, template name and all', () => {
	const params = mergeWizardAnswers({ class_name: 'Hero' }, { '--no-template': true });
	assert.equal(params.has_partial_template, false);
	assert.equal(params.partial_template_name, 'hero.php', 'still named, just not created');
});

test('properties typed in the wizard win; --prop fills in when none were', () => {
	const typed = mergeWizardAnswers(
		{ class_name: 'Hero' },
		{ '--prop': ['ignored:string'] },
		[{ name: 'quote', type: 'string', required: true, description: '' }]
	);
	assert.deepEqual(typed.properties.map((p) => p.name), ['quote']);

	const fromFlags = mergeWizardAnswers({ class_name: 'Hero' }, { '--prop': ['title:string'] }, []);
	assert.deepEqual(fromFlags.properties.map((p) => p.name), ['title']);
});
