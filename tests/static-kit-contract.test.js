// Guards the WonderPress <-> Static Kit boundary documented in ARCHITECTURE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Static Kit is a declared dependency (not vendored)', () => {
	const pkg = JSON.parse(read('package.json'));
	const dep = pkg.dependencies['@wndrfl/static-kit-cli'];
	assert.ok(dep, '@wndrfl/static-kit-cli must be a declared dependency');
	assert.match(dep, /^\^3\.1/, 'Static Kit 3.1+ must resolve from the registry, not a local checkout');
});

test('node_modules is git-ignored (nothing vendored is committed)', () => {
	const ignore = read('.gitignore');
	assert.match(ignore, /^node_modules$/m, '.gitignore must exclude node_modules');
});

test('init installs Static Kit via the CLI, not a vendored copy', () => {
	assert.match(
		read('src/core.js'),
		/installStaticKit\(\s*staticCli,\s*`\.\/wp-content\/themes\/wonderpress\/static`/,
		'core.js must set up static/ through installStaticKit'
	);
	assert.match(
		read('src/static-kit.js'),
		/staticCli\.core\.installKit\(/,
		'static-kit.js must install via staticCli.core.installKit'
	);
	assert.match(
		read('src/static-kit.js'),
		/kit\.compile\.all\(/,
		'static-kit.js must compile via kit.compile.all'
	);
	assert.doesNotMatch(read('src/static-kit.js'), /wonderpress-seed/);
});

test('the CLI delegates into static/ instead of scaffolding it', () => {
	assert.match(
		read('src/partial.js'),
		/staticCli\.component\.create\(\s*`\$\{themeDir\}\/static`/,
		'partial.js must delegate style creation to staticCli.component.create'
	);
	assert.match(
		read('src/partial.js'),
		/staticCli\.component\.remove\(\s*`\$\{themeDir\}\/static`/,
		'partial remove must delegate to staticCli.component.remove'
	);
	assert.match(
		read('src/template.js'),
		/staticCli\.template\.create\(\s*`\$\{themeDir\}\/static`/,
		'template.js must delegate template creation to staticCli.template.create'
	);
});

test('static compile is a root proxy into Static Kit, not an MCP tool', () => {
	assert.match(
		read('src/static.js'),
		/compileStatic\(dir, \{ watch \}\)/,
		'static compile must delegate through compileStatic',
	);
	assert.match(read('src/cli.js'), /case 'static':/);
	assert.doesNotMatch(
		read('src/mcp.js'),
		/static_compile|static compile/,
		'compile/watch must not be an MCP tool',
	);
});
