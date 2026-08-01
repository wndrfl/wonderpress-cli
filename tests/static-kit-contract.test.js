// Guards the WonderPress <-> Static Kit boundary documented in ARCHITECTURE.md.
// These are source-contract assertions: if a refactor breaks the seam (vendors
// node_modules instead of installing it, or scaffolds into `static/` instead of
// delegating to Static Kit), one of these fails and points back at the doc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Static Kit is a declared dependency (not vendored)', () => {
	const pkg = JSON.parse(read('package.json'));
	assert.ok(
		pkg.dependencies && pkg.dependencies['@wndrfl/static-kit-cli'],
		'@wndrfl/static-kit-cli must be a declared dependency'
	);
});

test('node_modules is git-ignored (nothing vendored is committed)', () => {
	const ignore = read('.gitignore');
	assert.match(ignore, /^node_modules$/m, '.gitignore must exclude node_modules');
});

test('init installs Static Kit via the CLI, not a vendored copy', () => {
	const core = read('src/core.js');
	assert.match(
		core,
		/staticCli\.core\.installKit\(\s*`\.\/wp-content\/themes\/wonderpress\/static`/,
		'core.js must set up static/ via staticCli.core.installKit (which runs npm install)'
	);
});

test('the CLI delegates into static/ instead of scaffolding it', () => {
	// partial create -> component style stub
	assert.match(
		read('src/partial.js'),
		/staticCli\.component\.create\(\s*`\$\{themeDir\}\/static`/,
		'partial.js must delegate style creation to staticCli.component.create'
	);
	// template create -> template
	assert.match(
		read('src/template.js'),
		/staticCli\.template\.create\(\s*`\$\{themeDir\}\/static`/,
		'template.js must delegate template creation to staticCli.template.create'
	);
});
