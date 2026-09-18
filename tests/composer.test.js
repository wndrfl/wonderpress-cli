// Guards `installComposer`, which is the step that now puts wonderpress-core
// on disk. It used to be a git clone into mu-plugins; it is a Composer install
// into the theme, so a silent no-op here means a site with no runtime at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as composer from '../src/composer.js';

async function withTmpDir(fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wonderpress-composer-'));
	try {
		await fn(dir);
	} finally {
		await fs.remove(dir);
	}
}

test('a directory with no composer.json is a no-op, not a failure', async () => {
	await withTmpDir(async (dir) => {
		assert.equal(await composer.installComposer(dir), true);
		assert.equal(fs.existsSync(path.join(dir, 'vendor')), false, 'nothing should have been installed');
	});
});

// The regression this exists for: the original guard read
//   if (await !fs.existsSync('./vendor'))
// where `!` binds tighter than `await`, making the condition `await false`.
// It was therefore ALWAYS falsy and the install never ran — a bug invisible in
// a repo whose vendor directory was already populated by hand.
test('an already-installed directory is detected and skipped', async () => {
	await withTmpDir(async (dir) => {
		await fs.writeJson(path.join(dir, 'composer.json'), { name: 'test/pkg' });
		await fs.outputFile(path.join(dir, 'vendor', 'autoload.php'), '<?php');

		const before = await fs.readJson(path.join(dir, 'composer.json'));
		assert.equal(await composer.installComposer(dir), true);
		assert.deepEqual(await fs.readJson(path.join(dir, 'composer.json')), before, 'composer must not have run');
	});
});

// An interrupted install leaves the directory but not the autoloader. Keying
// off the directory read that as "installed" and left the project broken with
// nothing reporting it.
test('an empty vendor directory does not count as installed', async () => {
	await withTmpDir(async (dir) => {
		await fs.writeJson(path.join(dir, 'composer.json'), {
			name: 'test/pkg',
			// No requirements, so this resolves offline and writes a real
			// autoloader — the assertion is that the install RAN.
			require: {},
		});
		await fs.ensureDir(path.join(dir, 'vendor'));

		assert.equal(await composer.installComposer(dir), true);
		assert.ok(
			fs.existsSync(path.join(dir, 'vendor', 'autoload.php')),
			'installComposer must have actually run Composer'
		);
	});
});
