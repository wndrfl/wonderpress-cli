import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import mysql2 from 'mysql2/promise';

// Full-lifecycle end-to-end: spin up a real environment with headless `init`,
// create a real partial in the installed theme, lint it, then spin down.
//
// Gated on WP_E2E (separate from WP_INTEGRATION) because it runs the real
// `init` — cloning the dev-environment + wonderpress-core from GitHub, a WP
// download, and composer/npm installs. Slow and network-dependent by nature;
// intended for a dedicated/scheduled CI job, not every push.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

const RUN = !!process.env.WP_E2E;
const DB_HOST = process.env.WP_DB_HOST || '127.0.0.1';
const DB_USER = process.env.WP_DB_USER || 'root';
const DB_PASSWORD = process.env.WP_DB_PASSWORD || '';
const DB_NAME = process.env.WP_E2E_DB || 'wonderpress_e2e';

async function dropDb() {
	const admin = await mysql2.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASSWORD });
	await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
	await admin.end();
}

test('lifecycle: init -> create partial -> lint -> teardown', { skip: !RUN, timeout: 600000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-e2e-'));
	const cwd = process.cwd();
	const childEnv = { ...process.env, WP_DB_PASSWORD: DB_PASSWORD, WP_ADMIN_PASSWORD: 'pw' };
	await dropDb();

	try {
		// 1. Spin up a real environment, fully headless.
		//
		// Captured rather than inherited so step 2 can inspect it. `init` drives
		// sub-tools (Static Kit, WP-CLI, Composer) that log their own failures and
		// carry on, so a zero exit says only "the CLI reached the end" — not "the
		// environment it built is sound". Echo it so CI logs stay as readable as
		// they were when this was stdio:'inherit'.
		const initRun = spawnSync('node', [
			BIN, 'init',
			'--dir', dir, '--yes',
			'--db-host', DB_HOST, '--db-user', DB_USER, '--db-name', DB_NAME,
			'--wp-url', 'example.test', '--wp-title', 'E2E', '--admin-user', 'admin',
			'--admin-email', 'admin@example.com', '--theme', 'wonderpress', '--skip-readme',
		], { encoding: 'utf8', env: childEnv });

		const initOutput = (initRun.stdout || '') + (initRun.stderr || '');
		process.stdout.write(initOutput);
		assert.equal(initRun.status, 0, 'init should exit cleanly');

		// 2. WordPress is installed and the wonderpress theme is active.
		execSync('wp core is-installed', { cwd: dir });
		const active = execSync('wp theme list --status=active --field=name', { cwd: dir, encoding: 'utf8' }).trim();
		assert.equal(active, 'wonderpress', 'wonderpress theme should be active');

		// 2b. The theme `init` produced is actually usable.
		//
		// Regression guard for a real escape: a sass/static-kit version pairing
		// left `sass.compileAsync` undefined, so every stylesheet failed to
		// compile. Static Kit logged it and returned, `init` exited 0, and every
		// assertion here still passed — a themeless theme, shipped green. Asserting
		// on the artifact rather than the exit code is what closes that gap.
		const distCssDir = path.join(dir, 'wp-content/themes/wonderpress/static/dist/css');
		const compiledCss = fs.existsSync(distCssDir)
			? fs.readdirSync(distCssDir).filter((f) => f.endsWith('.css'))
			: [];
		assert.ok(
			compiledCss.length > 0,
			`init should leave compiled CSS in static/dist/css (found none in ${distCssDir})`
		);

		// Sub-tools that log-and-continue are invisible to the exit code, so scan
		// for the shapes those failures take. Deliberately narrow: broad patterns
		// like /Error/ match benign WP-CLI chatter and make the nightly flaky.
		const swallowed = initOutput
			.split('\n')
			.filter((line) => /Static ERROR|Error when compiling|TypeError:|is not a function/.test(line));
		assert.deepEqual(swallowed, [], `init logged failures it did not exit on:\n${swallowed.join('\n')}`);

		// 3. Create a real partial in the installed theme.
		execFileSync('node', [
			BIN, 'partial', 'create',
			'--dir', dir, '--theme', 'wonderpress',
			'--name', 'Lifecycle_Test', '--block', '--prop', 'body:string:required',
		], { stdio: 'inherit', env: childEnv });

		const classFile = path.join(dir, 'wp-content/themes/wonderpress/src/partials/class-lifecycle-test.php');
		assert.ok(fs.existsSync(classFile), 'partial class should exist in the real theme');
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/wonderpress/blocks/lifecycle-test/block.json')), 'block.json should exist in the real theme');
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/wonderpress/blocks/lifecycle-test/render.php')), 'render.php should exist in the real theme');
		assert.ok(fs.existsSync(path.join(dir, 'wp-content/themes/wonderpress/.wonderpress/manifest/lifecycle-test.json')), 'manifest should exist in the real theme');

		// 4. Best-effort lint: assert the generated partial passes phpcs WHEN the
		// toolchain is available. The boilerplate currently pins a security-flagged
		// WPCS 2.3, which modern Composer refuses to install — an external issue
		// (the WPCS 2.x -> 3.x upgrade), not a CLI defect. So we assert clean when
		// phpcs resolved, and warn+skip (without failing the lifecycle) when it did not.
		const phpcs = path.join(dir, 'vendor', 'bin', 'phpcs');
		const partialRel = 'wp-content/themes/wonderpress/src/partials/class-lifecycle-test.php';
		if (fs.existsSync(phpcs)) {
			execSync(`"${phpcs}" --standard=phpcs.xml ${partialRel}`, { cwd: dir, stdio: 'inherit' });
		} else {
			console.warn('[e2e] phpcs unavailable (boilerplate composer could not resolve WPCS) — skipping the lint assertion; see the WPCS 2.x -> 3.x upgrade.');
		}
	} finally {
		// 5. Spin down.
		process.chdir(cwd);
		await dropDb();
		fs.removeSync(dir);
	}
});
