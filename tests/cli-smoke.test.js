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
		fs.writeFileSync(spec, JSON.stringify({ name: 'Smoke_Test', properties: [{ name: 'body', type: 'string', required: true }] }));

		const out = execFileSync('node', [BIN, 'partial', 'create', '--dir', dir, '--theme', 'smoke', '--json', '@' + spec], { encoding: 'utf8' });
		assert.match(out, /created/i);

		const classFile = path.join(dir, 'wp-content/themes/smoke/src/partials/class-smoke-test.php');
		assert.ok(fs.existsSync(classFile), 'class file should exist');

		const php = fs.readFileSync(classFile, 'utf8');
		assert.match(php, /class Smoke_Test extends Abstract_Partial/);
		assert.match(php, /'body'/);
		assert.doesNotMatch(php, /\\\$/); // no heredoc escaping leaked

		// the spine's additional outputs land too
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/smoke/blocks/smoke-test/block.json')), 'block.json should exist');
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/smoke/.wonderpress/manifest/smoke-test.json')), 'manifest should exist');
	} finally {
		fs.removeSync(dir);
	}
});
