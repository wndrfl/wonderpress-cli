import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { command, inspectTheme, phpcsBin } from '../src/lint.js';
import { writePhpcsStubs, writeStubBin } from './helpers/stub-bin.js';

function makeLintEnv({ failPhpcs = false, warnPhpcs = false } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-lint-'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
	const themeDir = path.join(root, 'wp-content/themes/acme');
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	fs.writeFileSync(path.join(themeDir, 'style.css'), '/* Theme Name: Acme */');

	const bin = path.join(root, 'vendor/bin');
	fs.ensureDirSync(bin);
	fs.writeFileSync(path.join(root, 'vendor/autoload.php'), '<?php');

	const failFlag = path.join(root, '.phpcs-fail');
	const warnFlag = path.join(root, '.phpcs-warn');
	const logFile = path.join(root, 'phpcbf.log');
	if (failPhpcs) {
		fs.writeFileSync(failFlag, '1');
	}
	if (warnPhpcs) {
		fs.writeFileSync(warnFlag, '1');
	}

	writePhpcsStubs(bin, { failFlag, warnFlag, logFile });

	return { root, themeDir, logFile };
}

function phpcbfRan(logFile) {
	return fs.existsSync(logFile);
}

test('inspectTheme without fix does not run phpcbf', async () => {
	const { root, logFile } = makeLintEnv({ failPhpcs: true });
	const cwd = process.cwd();
	try {
		const result = await inspectTheme(root, { name: 'acme' });
		assert.equal(result.ok, false);
		assert.equal(result.data.phpcs.ok, false);
		assert.ok(result.data.drift);
		assert.equal(result.data.fixed, undefined);
		assert.match(result.data.hint, /fix: true/);
		assert.equal(phpcbfRan(logFile), false);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('inspectTheme with fix: true runs phpcbf only after phpcs failure', async () => {
	const { root, logFile } = makeLintEnv({ failPhpcs: true });
	const cwd = process.cwd();
	try {
		const result = await inspectTheme(root, { name: 'acme', fix: true });
		assert.equal(result.ok, true);
		assert.equal(result.data.phpcs.ok, true);
		assert.equal(result.data.fixed, true);
		assert.equal(result.data.hint, undefined);
		assert.equal(phpcbfRan(logFile), true);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('inspectTheme fails a page template whose composition row is not rendered', async () => {
	const { root, themeDir } = makeLintEnv();
	const cwd = process.cwd();
	try {
		const manifestDir = path.join(themeDir, '.wonderpress/manifest/page-templates');
		fs.ensureDirSync(manifestDir);
		fs.ensureDirSync(path.join(themeDir, '.wonderpress/manifest/partials'));
		fs.writeFileSync(path.join(themeDir, '.wonderpress/manifest/partials/hero.json'), JSON.stringify({
			name: 'Hero',
			slug: 'hero',
		}));
		fs.writeFileSync(path.join(manifestDir, 'template-home.json'), JSON.stringify({
			schemaVersion: 1,
			template: 'template-home.php',
			composition: [{ id: 'hero-main', partial: 'hero' }],
		}));
		fs.writeFileSync(path.join(themeDir, 'template-home.php'), '<?php\n');
		const result = await inspectTheme(root, { name: 'acme' });
		assert.equal(result.ok, false);
		assert.equal(result.data.phpcs.ok, true);
		assert.equal(result.data.templates.ok, false);
		assert.equal(result.data.templates.results[0].issues[0].code, 'unrendered_partial');
		assert.match(result.data.hint, /template validate/);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('inspectTheme with fix: true runs phpcbf for auto-fixable warnings', async () => {
	const { root, logFile } = makeLintEnv({ warnPhpcs: true });
	const cwd = process.cwd();
	try {
		const result = await inspectTheme(root, { name: 'acme', fix: true });
		assert.equal(result.ok, true);
		assert.equal(result.data.phpcs.ok, true);
		assert.equal(result.data.phpcs.report.totals.fixable, 0);
		assert.equal(result.data.fixed, true);
		assert.equal(phpcbfRan(logFile), true);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('lint --fix runs phpcbf when phpcs only reports auto-fixable warnings', async () => {
	const { root, logFile } = makeLintEnv({ warnPhpcs: true });
	const cwd = process.cwd();
	const previousExit = process.exitCode;
	try {
		await command('theme', { '--dir': root, '--name': 'acme', '--fix': true });
		assert.equal(phpcbfRan(logFile), true);
		assert.equal(process.exitCode ?? 0, 0);
	} finally {
		process.exitCode = previousExit;
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('inspectTheme with fix: true does not run phpcbf when phpcs already passes', async () => {
	const { root, logFile } = makeLintEnv({ failPhpcs: false });
	const cwd = process.cwd();
	try {
		const result = await inspectTheme(root, { name: 'acme', fix: true });
		assert.equal(result.ok, true);
		assert.equal(result.data.phpcs.ok, true);
		assert.equal(result.data.fixed, undefined);
		assert.equal(phpcbfRan(logFile), false);
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('phpcsBin resolves the Composer proxy for the platform', () => {
	const root = path.join(os.tmpdir(), 'some root');
	assert.equal(phpcsBin('phpcs', { root, platform: 'darwin' }), path.join(root, 'vendor', 'bin', 'phpcs'));
	assert.equal(phpcsBin('phpcbf', { root, platform: 'linux' }), path.join(root, 'vendor', 'bin', 'phpcbf'));
	assert.equal(phpcsBin('phpcs', { root, platform: 'win32' }), path.join(root, 'vendor', 'bin', 'phpcs.bat'));
	assert.equal(phpcsBin('phpcbf', { root, platform: 'win32' }), path.join(root, 'vendor', 'bin', 'phpcbf.bat'));
});

test('a missing phpcs is a clear failure, not a shell error', async () => {
	const { root } = makeLintEnv();
	fs.removeSync(path.join(root, 'vendor/bin'));
	const cwd = process.cwd();
	try {
		const result = await inspectTheme(root, { name: 'acme', fix: true });
		assert.equal(result.ok, false);
		assert.equal(result.data.phpcs.ok, false);
		assert.match(result.data.phpcs.report.error, /phpcs(\.bat)? was not found at .*composer install/s);
		assert.equal(result.data.fixed, undefined, 'phpcbf is not attempted without phpcs');
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('a theme path with spaces reaches phpcs as one argument', async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wp lint spaced '));
	const root = path.join(parent, 'my project');
	const themeDir = path.join(root, 'wp-content/themes/acme');
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
	fs.writeFileSync(path.join(themeDir, 'style.css'), '/* Theme Name: Acme */');
	fs.ensureDirSync(path.join(root, 'vendor'));
	fs.writeFileSync(path.join(root, 'vendor/autoload.php'), '<?php');
	const argvLog = path.join(parent, 'argv.json');
	writeStubBin(path.join(root, 'vendor/bin'), 'phpcs', `
require('fs').writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{"totals":{"errors":0,"warnings":0,"fixable":0},"files":{}}\\n');
`);
	const cwd = process.cwd();
	try {
		const result = await inspectTheme(root, { name: 'acme' });
		assert.equal(result.data.phpcs.ok, true);
		const argv = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
		assert.equal(argv.length, 2);
		assert.equal(fs.realpathSync(argv[0]), fs.realpathSync(themeDir));
		assert.equal(argv[1], '--report=json');
	} finally {
		process.chdir(cwd);
		fs.removeSync(parent);
	}
});
