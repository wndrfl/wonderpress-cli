import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { paramsFromFlags, writePartial, syncPartialFromManifest } from '../src/partial.js';
import { checkPartialDrift } from '../src/partial-drift.js';
import {
	FenceError,
	FENCE_OPEN,
	FENCE_CLOSE,
	extractFencedRegion,
	locateFence,
	planPartialClassWrite,
	renderFencedRegion,
	renderLegacyPartialClassSource,
	renderPartialClassSource,
} from '../src/partial-class.js';
import { parseEnvelope } from '../src/format.js';
import { handlers } from '../src/mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

// Stable theme basename inside a random parent, for the same reason as
// partial.test.js: the block namespace derives from it.
function tmpTheme() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fence-')), 'wonderpress');
	fs.ensureDirSync(path.join(dir, 'src/partials'));
	fs.ensureDirSync(path.join(dir, 'partials'));
	return dir;
}

const MANIFEST = '.wonderpress/manifest/partials/hero.json';
const CLASS = 'src/partials/class-hero.php';

const USER_METHOD = `
	/**
	 * Custom, hand-written: must survive every sync.
	 */
	public function variant_class() {
		return 'hero--wide';
	}
`;

async function createHero(dir, extra = {}) {
	await writePartial(paramsFromFlags({ '--name': 'Hero', '--prop': ['title:string:required'], '--no-style': true, ...extra }), dir);
	return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
}

function addProp(dir, manifest, name) {
	manifest.properties.push({ name, type: 'string', required: false, description: '' });
	fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
	return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
}

// Put user code inside the class, right after the closing fence marker.
function insertBelowFence(source, code) {
	const marker = `${FENCE_CLOSE}\n`;
	assert.ok(source.includes(marker));
	return source.replace(marker, marker + code);
}

const heroParams = (props = ['title:string:required']) => paramsFromFlags({ '--name': 'Hero', '--prop': props });

test('the class template wraps every machine-owned member in one fence', () => {
	const src = renderPartialClassSource(paramsFromFlags({ '--name': 'Hero', '--acf': true, '--prop': ['title:string'] }));
	const region = extractFencedRegion(src);
	assert.ok(region.startsWith(FENCE_OPEN));
	assert.ok(region.endsWith(FENCE_CLOSE));
	for (const member of ['$acf_compatible', '$partial_template', '$properties']) {
		assert.ok(region.includes(member), `${member} is inside the fence`);
		assert.equal(src.split(`protected ${member.startsWith('$properties') ? 'static ' : ''}${member} `).length, 2, `${member} declared once`);
	}
	// The class declaration and closing brace are the user's.
	const at = locateFence(src);
	assert.match(src.slice(0, at.start), /class Hero extends Abstract_Partial \{/);
	assert.equal(src.slice(at.end), '\n}\n');
	assert.match(src, /below\s+\* the closing marker/);
});

test('renderFencedRegion is exactly the fenced slice of the full render', () => {
	const params = heroParams();
	assert.equal(renderFencedRegion(params), extractFencedRegion(renderPartialClassSource(params)));
});

test('extractFencedRegion returns null without fences and throws on malformed ones', () => {
	assert.equal(extractFencedRegion('<?php\nclass A {}\n'), null);
	assert.throws(() => extractFencedRegion(`\t${FENCE_OPEN}\n\t${FENCE_OPEN}\n\t${FENCE_CLOSE}\n`), FenceError);
	assert.throws(() => extractFencedRegion(`\t${FENCE_CLOSE}\n\t${FENCE_OPEN}\n`), FenceError);
	assert.throws(() => extractFencedRegion(`\t${FENCE_OPEN}\n`), FenceError);
	// A marker that is not alone on its line is not a fence.
	assert.equal(extractFencedRegion(`$x = '${FENCE_OPEN}';\n`), null);
});

test('sync keeps user methods below the fence byte for byte while updating the region', async () => {
	const dir = tmpTheme();
	try {
		let manifest = await createHero(dir);
		const classFile = path.join(dir, CLASS);
		const customized = insertBelowFence(fs.readFileSync(classFile, 'utf8'), USER_METHOD);
		fs.writeFileSync(classFile, customized);

		manifest = addProp(dir, manifest, 'dek');
		syncPartialFromManifest(manifest, dir);

		const after = fs.readFileSync(classFile, 'utf8');
		assert.ok(after.includes(USER_METHOD), 'custom method survived');
		assert.match(extractFencedRegion(after), /'dek'/, 'region regenerated');
		// Everything outside the region is unchanged.
		const before = locateFence(customized);
		const now = locateFence(after);
		assert.equal(after.slice(0, now.start), customized.slice(0, before.start));
		assert.equal(after.slice(now.end), customized.slice(before.end));
		assert.equal(checkPartialDrift(manifest, dir).ok, true);
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('a fenced CRLF file keeps CRLF everywhere, including the regenerated region', async () => {
	const dir = tmpTheme();
	try {
		let manifest = await createHero(dir);
		const classFile = path.join(dir, CLASS);
		const crlf = insertBelowFence(fs.readFileSync(classFile, 'utf8'), USER_METHOD).replace(/\n/g, '\r\n');
		fs.writeFileSync(classFile, crlf);

		manifest = addProp(dir, manifest, 'dek');
		syncPartialFromManifest(manifest, dir);

		const after = fs.readFileSync(classFile, 'utf8');
		assert.match(after, /'dek'/);
		assert.equal(after.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF introduced');
		assert.ok(after.includes(USER_METHOD.replace(/\n/g, '\r\n')));
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('a legacy class that still matches the old render is migrated to fences silently', async () => {
	const dir = tmpTheme();
	try {
		let manifest = await createHero(dir);
		const classFile = path.join(dir, CLASS);
		fs.writeFileSync(classFile, renderLegacyPartialClassSource(heroParams()));
		assert.equal(checkPartialDrift(manifest, dir).ok, true, 'an untouched legacy file is not drift');

		manifest = addProp(dir, manifest, 'dek');
		syncPartialFromManifest(manifest, dir);

		const after = fs.readFileSync(classFile, 'utf8');
		assert.equal(after, renderPartialClassSource(heroParams(['title:string:required', 'dek:string'])));
		assert.equal(checkPartialDrift(manifest, dir).ok, true);
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('legacy pristine detection reads generated values back, so any hand edit fails it', () => {
	const acf = paramsFromFlags({ '--name': 'Hero', '--acf': true, '--template-name': 'hero-view.php', '--prop': ['title:string:required', 'cta:link'] });
	acf.properties[0].description = 'It\'s the <main> "headline" & more';
	const legacy = renderLegacyPartialClassSource(acf);
	assert.equal(planPartialClassWrite(legacy, heroParams()).mode, 'migrate', 'older properties still count as pristine');
	assert.equal(planPartialClassWrite(legacy.replace(/\n/g, '\r\n'), heroParams()).mode, 'migrate');
	assert.equal(planPartialClassWrite(legacy, heroParams()).source, renderPartialClassSource(heroParams()));

	for (const edit of [
		legacy.replace(/\n\}\n$/, `\n${USER_METHOD}}\n`),
		legacy.replace(' * @package', ' * Note from a human.\n * @package'),
		legacy.replace("'cta'   =>", "'cta' =>"),
		legacy + '\n',
	]) {
		assert.throws(() => planPartialClassWrite(edit, heroParams()), (err) => err.code === 'class_unfenced');
	}
});

test('a hand-edited legacy class is refused without --force and rewritten with it', async () => {
	const dir = tmpTheme();
	try {
		const manifest = await createHero(dir);
		const classFile = path.join(dir, CLASS);
		const legacy = renderLegacyPartialClassSource(heroParams()).replace(/\n\}\n$/, `\n${USER_METHOD}}\n`);
		fs.writeFileSync(classFile, legacy);

		assert.equal(checkPartialDrift(manifest, dir).issues[0].code, 'class_drift');

		assert.throws(() => syncPartialFromManifest(manifest, dir), (err) => {
			assert.ok(err instanceof FenceError);
			assert.equal(err.code, 'class_unfenced');
			assert.ok(err.message.includes(CLASS), 'names the file');
			assert.match(err.message, /--force/);
			assert.match(err.message, /below the \/\/ <\/wonderpress:generated> line/);
			return true;
		});
		assert.equal(fs.readFileSync(classFile, 'utf8'), legacy, 'nothing written on refusal');

		const plan = syncPartialFromManifest(manifest, dir, { dryRun: true });
		assert.equal(plan.classAction, 'refuse');
		assert.match(plan.classError, /--force/);

		syncPartialFromManifest(manifest, dir, { force: true });
		assert.equal(fs.readFileSync(classFile, 'utf8'), renderPartialClassSource(heroParams()));
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('malformed fences are refused, reported as drift, and fixable with force', () => {
	const params = heroParams();
	const broken = renderPartialClassSource(params).replace(`\t${FENCE_CLOSE}\n`, '');
	assert.throws(() => planPartialClassWrite(broken, params), (err) => err.code === 'class_fence');
	assert.equal(planPartialClassWrite(broken, params, { force: true }).mode, 'force');
});

test('dry-run reports the class action without writing', async () => {
	const dir = tmpTheme();
	try {
		const manifest = await createHero(dir);
		assert.equal(syncPartialFromManifest(manifest, dir, { dryRun: true }).classAction, 'unchanged');
		fs.writeFileSync(path.join(dir, CLASS), renderLegacyPartialClassSource(heroParams()));
		assert.equal(syncPartialFromManifest(manifest, dir, { dryRun: true }).classAction, 'migrate');
		assert.equal(fs.readFileSync(path.join(dir, CLASS), 'utf8'), renderLegacyPartialClassSource(heroParams()));
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('sync honors manifest.artifacts.class and keeps that path in the manifest', async () => {
	const dir = tmpTheme();
	try {
		let manifest = await createHero(dir);
		const custom = 'inc/partials/hero-class.php';
		fs.ensureDirSync(path.join(dir, 'inc/partials'));
		fs.moveSync(path.join(dir, CLASS), path.join(dir, custom));
		fs.appendFileSync(path.join(dir, custom), '// trailing user comment\n');
		manifest.artifacts.class = custom;
		manifest = addProp(dir, manifest, 'dek');

		syncPartialFromManifest(manifest, dir);

		assert.equal(fs.existsSync(path.join(dir, CLASS)), false, 'default path not recreated');
		const after = fs.readFileSync(path.join(dir, custom), 'utf8');
		assert.match(after, /'dek'/);
		assert.ok(after.endsWith('// trailing user comment\n'));
		const normalized = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
		assert.equal(normalized.artifacts.class, custom);
		assert.equal(checkPartialDrift(normalized, dir).ok, true);
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('drift flags an edit inside the fence and ignores one outside it', async () => {
	const dir = tmpTheme();
	try {
		const manifest = await createHero(dir);
		const classFile = path.join(dir, CLASS);
		const pristine = fs.readFileSync(classFile, 'utf8');

		fs.writeFileSync(classFile, insertBelowFence(pristine, USER_METHOD));
		assert.equal(checkPartialDrift(manifest, dir).ok, true, 'outside the fence is the user\'s');

		fs.writeFileSync(classFile, pristine.replace("'required'    => true", "'required'    => false"));
		const inside = checkPartialDrift(manifest, dir);
		assert.equal(inside.ok, false);
		assert.equal(inside.issues[0].code, 'class_drift');
		assert.match(inside.issues[0].message, /Generated region/);

		fs.writeFileSync(classFile, pristine.replace(`\t${FENCE_OPEN}\n`, ''));
		const malformed = checkPartialDrift(manifest, dir);
		assert.equal(malformed.issues[0].code, 'class_drift');
		assert.match(malformed.issues[0].message, /malformed/);
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('create over an existing fenced class keeps code below the fence', async () => {
	const dir = tmpTheme();
	try {
		await createHero(dir);
		const classFile = path.join(dir, CLASS);
		fs.writeFileSync(classFile, insertBelowFence(fs.readFileSync(classFile, 'utf8'), USER_METHOD));
		await createHero(dir);
		assert.ok(fs.readFileSync(classFile, 'utf8').includes(USER_METHOD));
	} finally {
		fs.removeSync(path.dirname(dir));
	}
});

test('CLI: partial sync refuses a hand-edited legacy class with a JSON error, --force rewrites it', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fence-cli-'));
	const run = (argv) => spawnSync('node', [BIN, ...argv, '--dir', root, '--theme', 'smoke'], { encoding: 'utf8' });
	try {
		fs.writeFileSync(path.join(root, '.wonderpressrc'), '{}');
		const themeDir = path.join(root, 'wp-content/themes/smoke');
		fs.ensureDirSync(path.join(themeDir, 'src/partials'));
		fs.ensureDirSync(path.join(themeDir, 'partials'));
		run(['partial', 'create', '--name', 'Hero', '--prop', 'title:string:required', '--no-style']);
		const classFile = path.join(themeDir, CLASS);
		fs.writeFileSync(classFile, renderLegacyPartialClassSource(heroParams()).replace(/\n\}\n$/, `\n${USER_METHOD}}\n`));

		const refused = run(['partial', 'sync', 'Hero', '--format', 'json']);
		assert.notEqual(refused.status, 0);
		const lines = refused.stdout.trim().split('\n');
		assert.equal(lines.length, 1, 'exactly one envelope on stdout');
		const body = parseEnvelope(refused.stdout);
		assert.equal(body.ok, false);
		assert.equal(body.error.code, 'class_unfenced');
		assert.match(body.error.hint, /--force/);

		const forced = run(['partial', 'sync', 'Hero', '--force', '--format', 'json']);
		assert.equal(forced.status, 0, forced.stderr);
		assert.equal(parseEnvelope(forced.stdout).ok, true);
		assert.ok(extractFencedRegion(fs.readFileSync(classFile, 'utf8')));
	} finally {
		fs.removeSync(root);
	}
});

test('MCP: partial_sync refuses with a code and accepts force', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-fence-mcp-'));
	const themeDir = path.join(root, 'wp-content/themes/acme');
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	const cwd = process.cwd();
	const parse = (r) => JSON.parse(r.content[0].text);
	try {
		process.chdir(root);
		await createHero(themeDir);
		const classFile = path.join(themeDir, CLASS);
		fs.writeFileSync(classFile, renderLegacyPartialClassSource(heroParams()).replace(/\n\}\n$/, `\n${USER_METHOD}}\n`));

		const refused = parse(await handlers.partial_sync({ dir: root, theme: 'acme', name: 'Hero' }));
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, 'class_unfenced');

		const forced = parse(await handlers.partial_sync({ dir: root, theme: 'acme', name: 'Hero', force: true }));
		assert.equal(forced.ok, true);
		assert.ok(extractFencedRegion(fs.readFileSync(classFile, 'utf8')));
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});
