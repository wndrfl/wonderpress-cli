import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlers, createWonderpressMcpServer } from '../src/mcp.js';
import { writePartial, paramsFromFlags, listPartials } from '../src/partial.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

function makeEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mcp-'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
	const themeDir = path.join(root, 'wp-content/themes/acme');
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	return { root, themeDir };
}

function makeLintEnv({ failPhpcs = false } = {}) {
	const { root, themeDir } = makeEnv();
	fs.writeFileSync(path.join(themeDir, 'style.css'), '/* Theme Name: Acme */');
	const bin = path.join(root, 'vendor/bin');
	fs.ensureDirSync(bin);
	fs.writeFileSync(path.join(root, 'vendor/autoload.php'), '<?php');
	const failFlag = path.join(root, '.phpcs-fail');
	const logFile = path.join(root, 'phpcbf.log');
	if (failPhpcs) {
		fs.writeFileSync(failFlag, '1');
	}
	fs.writeFileSync(path.join(bin, 'phpcs'), `#!/bin/sh
if [ -f ${JSON.stringify(failFlag)} ]; then
  echo '{"totals":{"errors":1,"warnings":0,"fixable":1},"files":{}}'
  exit 1
fi
echo '{"totals":{"errors":0,"warnings":0,"fixable":0},"files":{}}'
exit 0
`);
	fs.writeFileSync(path.join(bin, 'phpcbf'), `#!/bin/sh
echo ran >> ${JSON.stringify(logFile)}
rm -f ${JSON.stringify(failFlag)}
exit 0
`);
	fs.chmodSync(path.join(bin, 'phpcs'), 0o755);
	fs.chmodSync(path.join(bin, 'phpcbf'), 0o755);
	return { root, themeDir, logFile };
}

function parse(result) {
	return JSON.parse(result.content[0].text);
}

test('MCP server registers the planned tools', () => {
	const server = createWonderpressMcpServer();
	assert.ok(server);
});

test('Static Kit is not a static import on the MCP load path', () => {
	const staticImport = /from\s+['"]@wndrfl\/static-kit-cli['"]/;
	for (const rel of ['core.js', 'partial.js', 'template.js']) {
		const source = fs.readFileSync(path.join(SRC, rel), 'utf8');
		assert.doesNotMatch(
			source,
			staticImport,
			`${rel} must lazy-import Static Kit so MCP startup never loads sharp`,
		);
		assert.match(source, /import\(['"]@wndrfl\/static-kit-cli['"]\)/);
	}
});

test('partial_list works without needing a Static Kit write', async () => {
	const { root, themeDir } = makeEnv();
	const cwd = process.cwd();
	try {
		process.chdir(root);
		await writePartial(paramsFromFlags({ '--name': 'Hero', '--no-style': true }), themeDir);
		const listed = parse(await handlers.partial_list({ dir: root, theme: 'acme' }));
		assert.equal(listed.ok, true);
		assert.equal(listed.partials.length, 1);
		assert.equal(listed.partials[0].slug, 'hero');
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('partial_create then partial_get match CLI --json create', async () => {
	const { root } = makeEnv();
	const cwd = process.cwd();
	try {
		process.chdir(root);
		const created = parse(await handlers.partial_create({
			dir: root,
			theme: 'acme',
			spec: { name: 'Quote', block: true, properties: [{ name: 'body', type: 'string', required: true }] },
		}));
		assert.equal(created.ok, true);
		assert.equal(created.slug, 'quote');

		const got = parse(await handlers.partial_get({ dir: root, theme: 'acme', slug: 'quote' }));
		assert.equal(got.ok, true);
		assert.equal(got.manifest.slug, 'quote');
		assert.equal(got.manifest.block, 'acme/quote');

		const listed = parse(await handlers.partial_list({ dir: root, theme: 'acme' }));
		assert.equal(listed.partials.length, 1);

		const viaFlags = path.join(root, 'wp-content/themes/acme');
		assert.equal(listPartials(viaFlags)[0].slug, 'quote');
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('partial_remove requires confirm', async () => {
	const { root, themeDir } = makeEnv();
	const cwd = process.cwd();
	try {
		process.chdir(root);
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), themeDir);
		const refused = parse(await handlers.partial_remove({ dir: root, theme: 'acme', name: 'Hero' }));
		assert.equal(refused.ok, false);
		assert.match(refused.error.message, /confirm/);
		assert.ok(fs.existsSync(path.join(themeDir, 'src/partials/class-hero.php')));

		const removed = parse(await handlers.partial_remove({ dir: root, theme: 'acme', name: 'Hero', confirm: true }));
		assert.equal(removed.ok, true);
		assert.ok(!fs.existsSync(path.join(themeDir, 'src/partials/class-hero.php')));
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('lint_theme without fix does not run phpcbf', async () => {
	const { root, logFile } = makeLintEnv({ failPhpcs: true });
	const cwd = process.cwd();
	try {
		const listed = parse(await handlers.lint_theme({ dir: root, theme: 'acme' }));
		assert.equal(listed.ok, false);
		assert.equal(listed.phpcs.ok, false);
		assert.ok(listed.drift);
		assert.equal(listed.fixed, undefined);
		assert.match(listed.hint, /fix: true/);
		assert.equal(fs.existsSync(logFile), false);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('lint_theme with fix: true runs phpcbf then re-inspects', async () => {
	const { root, logFile } = makeLintEnv({ failPhpcs: true });
	const cwd = process.cwd();
	try {
		const fixed = parse(await handlers.lint_theme({ dir: root, theme: 'acme', fix: true }));
		assert.equal(fixed.ok, true);
		assert.equal(fixed.phpcs.ok, true);
		assert.equal(fixed.fixed, true);
		assert.ok(fixed.drift);
		assert.ok(fs.existsSync(logFile));
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('lint_theme with fix: true skips phpcbf when phpcs already passes', async () => {
	const { root, logFile } = makeLintEnv({ failPhpcs: false });
	const cwd = process.cwd();
	try {
		const listed = parse(await handlers.lint_theme({ dir: root, theme: 'acme', fix: true }));
		assert.equal(listed.ok, true);
		assert.equal(listed.phpcs.ok, true);
		assert.equal(listed.fixed, undefined);
		assert.equal(fs.existsSync(logFile), false);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('partial_add_js scaffolds JS onto an existing partial', async () => {
	const { root, themeDir } = makeEnv();
	const cwd = process.cwd();
	try {
		process.chdir(root);
		fs.ensureDirSync(path.join(themeDir, 'static'));
		fs.writeFileSync(path.join(themeDir, 'static/.staticrc'), JSON.stringify({
			paths: {
				src: { js: 'src/js', scss: 'src/scss', images: 'src/images' },
				dist: { js: 'dist/js', css: 'dist/css', images: 'dist/images' },
			},
		}));
		await writePartial(paramsFromFlags({ '--name': 'Quote' }), themeDir);

		const missing = parse(await handlers.partial_add_js({ dir: root, theme: 'acme' }));
		assert.equal(missing.ok, false);

		const added = parse(await handlers.partial_add_js({ dir: root, theme: 'acme', name: 'Quote' }));
		assert.equal(added.ok, true);
		assert.equal(added.script, 'static/src/js/lib/partials/Quote.js');
		assert.ok(fs.existsSync(path.join(themeDir, 'static/src/js/lib/partials/Quote.js')));
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});
