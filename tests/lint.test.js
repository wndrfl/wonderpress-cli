import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { command, inspectTheme } from '../src/lint.js';

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

	fs.writeFileSync(path.join(bin, 'phpcs'), `#!/bin/sh
mode=human
for arg in "$@"; do
  case "$arg" in
    --report=json) mode=json ;;
  esac
done
if [ -f ${JSON.stringify(failFlag)} ]; then
  if [ "$mode" = json ]; then
    echo '{"totals":{"errors":1,"warnings":0,"fixable":1},"files":{}}'
  fi
  exit 1
fi
if [ -f ${JSON.stringify(warnFlag)} ]; then
  if [ "$mode" = json ]; then
    echo '{"totals":{"errors":0,"warnings":5,"fixable":5},"files":{}}'
  else
    echo 'PHPCBF CAN FIX THE 5 MARKED SNIFF VIOLATIONS AUTOMATICALLY'
  fi
  exit 0
fi
if [ "$mode" = json ]; then
  echo '{"totals":{"errors":0,"warnings":0,"fixable":0},"files":{}}'
fi
exit 0
`);
	fs.writeFileSync(path.join(bin, 'phpcbf'), `#!/bin/sh
echo ran >> ${JSON.stringify(logFile)}
rm -f ${JSON.stringify(failFlag)} ${JSON.stringify(warnFlag)}
exit 0
`);
	fs.chmodSync(path.join(bin, 'phpcs'), 0o755);
	fs.chmodSync(path.join(bin, 'phpcbf'), 0o755);

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
