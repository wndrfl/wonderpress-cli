import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { compileStatic, installStaticKit } from '../src/static-kit.js';

function fakeStaticKit(log) {
	return {
		core: {
			async installKit(dir, opts) {
				if (fs.existsSync(path.join(dir, '.staticrc'))) {
					log.push('skipped');
					return { ok: true, data: { dir, skipped: true }, error: null };
				}
				fs.ensureDirSync(path.join(dir, 'src/scss/lib'));
				fs.writeFileSync(path.join(dir, '.staticrc'), '{}');
				fs.writeFileSync(path.join(dir, 'src/scss/index.scss'), '@use "lib/utilities";\n');
				log.push(`installed:compile=${opts.compile}`);
				return { ok: true, data: { dir, skipped: false }, error: null };
			},
		},
		compile: {
			async all({ dir }) {
				const lib = path.join(dir, 'src/scss/lib');
				const entries = fs.existsSync(lib) ? fs.readdirSync(lib) : [];
				fs.ensureDirSync(path.join(dir, 'dist/css'));
				fs.writeFileSync(path.join(dir, 'dist/css/index.css'), entries.join(','));
				log.push('compiled');
				return { ok: true, data: { dir }, error: null };
			},
		},
	};
}

function makeTheme() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-static-kit-'));
}

test('installStaticKit installs and compiles into an untouched directory', async () => {
	const root = makeTheme();
	try {
		const log = [];
		await installStaticKit(fakeStaticKit(log), path.join(root, 'static'), { init: true });
		assert.deepEqual(log, ['installed:compile=false', 'compiled']);
		assert.ok(fs.existsSync(path.join(root, 'static/dist/css/index.css')));
	} finally {
		fs.removeSync(root);
	}
});

test('installStaticKit installs and compiles around files the scaffold seeded', async () => {
	const root = makeTheme();
	try {
		const staticDir = path.join(root, 'static');
		fs.ensureDirSync(path.join(staticDir, 'src/scss/lib'));
		fs.writeFileSync(path.join(staticDir, 'src/scss/lib/_utilities.scss'), '.screen-reader-text {}\n');

		const log = [];
		await installStaticKit(fakeStaticKit(log), staticDir, { init: true });

		assert.deepEqual(log, ['installed:compile=false', 'compiled'], 'seeded files must not skip the install');
		assert.ok(fs.existsSync(path.join(staticDir, '.staticrc')), 'the framework should be installed');
		assert.ok(fs.existsSync(path.join(staticDir, 'src/scss/lib/_utilities.scss')), 'the seeded file should survive');
		assert.equal(
			fs.readFileSync(path.join(staticDir, 'dist/css/index.css'), 'utf8'),
			'_utilities.scss',
			'the seeded file should be in place before compilation',
		);
	} finally {
		fs.removeSync(root);
	}
});

test('installStaticKit leaves an existing installation alone but still compiles', async () => {
	const root = makeTheme();
	try {
		const staticDir = path.join(root, 'static');
		fs.ensureDirSync(path.join(staticDir, 'src/scss/lib'));
		fs.writeFileSync(path.join(staticDir, '.staticrc'), '{}');

		const log = [];
		await installStaticKit(fakeStaticKit(log), staticDir, { init: true });
		assert.deepEqual(log, ['skipped', 'compiled']);
	} finally {
		fs.removeSync(root);
	}
});

test('compileStatic refuses a directory that is not a Static Kit tree', async () => {
	const root = makeTheme();
	try {
		const result = await compileStatic(path.join(root, 'static'));
		assert.equal(result.ok, false);
		assert.equal(result.error.code, 'static');
	} finally {
		fs.removeSync(root);
	}
});

test('compileStatic delegates to Static Kit with the theme static/ path', async () => {
	const root = makeTheme();
	try {
		const staticDir = path.join(root, 'static');
		fs.ensureDirSync(staticDir);
		fs.writeFileSync(path.join(staticDir, '.staticrc'), '{}');
		const calls = [];
		const result = await compileStatic(staticDir, {
			watch: false,
			staticCli: {
				compile: {
					async all(opts) {
						calls.push(opts);
						return { ok: true, data: opts, error: null };
					},
				},
			},
		});
		assert.equal(result.ok, true);
		assert.equal(result.data.dir, staticDir);
		assert.equal(result.data.watch, false);
		assert.deepEqual(calls, [{ dir: staticDir, watch: false }]);
	} finally {
		fs.removeSync(root);
	}
});

test('compileStatic passes --watch through to Static Kit', async () => {
	const root = makeTheme();
	try {
		const staticDir = path.join(root, 'static');
		fs.ensureDirSync(staticDir);
		fs.writeFileSync(path.join(staticDir, '.staticrc'), '{}');
		const calls = [];
		await compileStatic(staticDir, {
			watch: true,
			staticCli: {
				compile: {
					async all(opts) {
						calls.push(opts);
						return { ok: true, data: opts, error: null };
					},
				},
			},
		});
		assert.equal(calls[0].watch, true);
	} finally {
		fs.removeSync(root);
	}
});
