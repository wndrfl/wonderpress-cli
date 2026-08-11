import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

// A lightweight env-root fixture: just enough for `partial create --theme` to
// resolve without a database (no WP install, no wp-cli needed).
function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-env-'));
	fs.writeFileSync(path.join(dir, '.wonderpressrc'), '{}');
	fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/src/partials'));
	fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/partials'));
	return dir;
}

test('partial create --json runs headlessly against a fixture', () => {
	const dir = makeFixture();
	try {
		const spec = path.join(dir, 'spec.json');
		fs.writeFileSync(spec, JSON.stringify({ name: 'Smoke_Test', block: true, properties: [{ name: 'body', type: 'string', required: true }] }));

		const out = execFileSync('node', [BIN, 'partial', 'create', '--dir', dir, '--theme', 'smoke', '--json', '@' + spec], { encoding: 'utf8' });
		assert.match(out, /created/i);

		const classFile = path.join(dir, 'wp-content/themes/smoke/src/partials/class-smoke-test.php');
		assert.ok(fs.existsSync(classFile), 'class file should exist');

		const php = fs.readFileSync(classFile, 'utf8');
		assert.match(php, /class Smoke_Test extends Abstract_Partial/);
		assert.match(php, /'body'/);
		assert.doesNotMatch(php, /\\\$/); // no heredoc escaping leaked

		// the spine's additional outputs land too (block opted in via the spec)
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/smoke/blocks/smoke-test/block.json')), 'block.json should exist');
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/smoke/blocks/smoke-test/render.php')), 'render.php should exist');
		const manifestFile = path.join(dir, 'wp-content/themes/smoke/.wonderpress/manifest/smoke-test.json');
		assert.ok(fs.existsSync(manifestFile), 'manifest should exist');

		// This fixture has no Static Kit tree, so the delegated halves cannot land.
		// The manifest must say so rather than advertising files that do not exist.
		const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
		assert.equal(manifest.artifacts.style, undefined, 'no style artifact without a static tree');
		assert.equal(manifest.artifacts.script, undefined, 'no script artifact without a static tree');
		for (const [key, rel] of Object.entries(manifest.artifacts)) {
			assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/smoke', rel)), `artifacts.${key} (${rel}) should exist`);
		}
	} finally {
		fs.removeSync(dir);
	}
});

test('partial/block list + remove route through the CLI against a fixture', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-env-'));
	const run = (...argv) => execFileSync('node', [BIN, ...argv, '--dir', dir, '--theme', 'smoke'], { encoding: 'utf8' });
	try {
		fs.writeFileSync(path.join(dir, '.wonderpressrc'), '{}');
		fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/src/partials'));
		fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/partials'));

		run('partial', 'create', '--name', 'Smoke_Test', '--block');

		const partials = run('partial', 'list');
		assert.match(partials, /Smoke_Test\s+smoke-test\s+wonderpress\/smoke-test/);
		assert.match(run('block', 'list'), /wonderpress\/smoke-test\s+Smoke_Test/);

		// A block wraps a partial, so the partial cannot be removed out from under it.
		assert.match(run('partial', 'remove', 'Smoke_Test'), /wrapped by block wonderpress\/smoke-test/);
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/smoke/src/partials/class-smoke-test.php')));

		run('block', 'remove', 'Smoke_Test');
		assert.ok(!fs.existsSync(path.join(dir, 'wp-content/themes/smoke/blocks/smoke-test')));

		run('partial', 'remove', 'Smoke_Test');
		assert.ok(!fs.existsSync(path.join(dir, 'wp-content/themes/smoke/src/partials/class-smoke-test.php')));
		assert.ok(!fs.existsSync(path.join(dir, 'wp-content/themes/smoke/.wonderpress/manifest/smoke-test.json')));
		assert.match(run('partial', 'list'), /No partials found/);
	} finally {
		fs.removeSync(dir);
	}
});
