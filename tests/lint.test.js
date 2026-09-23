import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { inspectTheme } from '../src/lint.js';

function makeLintEnv({ failPhpcs = false } = {}) {
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
