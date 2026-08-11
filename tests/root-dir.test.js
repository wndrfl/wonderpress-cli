import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as core from '../src/core.js';

/**
 * getRootDir walks up from a starting directory looking for the environment
 * marker (.wonderpressrc, or the legacy .wonderpress).
 *
 * The walk was broken: it built `../${path}` from an absolute path, so every
 * iteration produced a nonexistent directory and it only ever succeeded when
 * the starting directory *was* the root. These tests pin the fixed behavior —
 * including the one hazard fixing it introduced, a marker in $HOME.
 *
 * The `startDir` parameter exists so this is testable without chdir'ing the
 * whole process.
 **/

function tmpTree() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-rootdir-'));
	// fs.realpath: macOS hands out /var/folders/... symlinks for tmpdir, and
	// path.resolve does not follow them, so the assertions need the real path.
	return fs.realpathSync(root);
}

test('finds the marker in the starting directory itself', async () => {
	const root = tmpTree();
	try {
		fs.writeFileSync(path.join(root, '.wonderpressrc'), '{}');
		assert.equal(await core.getRootDir(root), root);
	} finally {
		fs.removeSync(root);
	}
});

test('walks up from a nested subdirectory to the root', async () => {
	const root = tmpTree();
	try {
		fs.writeFileSync(path.join(root, '.wonderpressrc'), '{}');
		const deep = path.join(root, 'wp-content', 'themes', 'wonderpress', 'partials');
		fs.ensureDirSync(deep);

		// This is the case that used to fail: every command run from inside the
		// theme printed "This does not appear to be a Wonderpress Development
		// Environment."
		assert.equal(await core.getRootDir(deep), root);
	} finally {
		fs.removeSync(root);
	}
});

test('honors the legacy .wonderpress marker', async () => {
	const root = tmpTree();
	try {
		fs.writeFileSync(path.join(root, '.wonderpress'), '{}');
		const sub = path.join(root, 'wp-content');
		fs.ensureDirSync(sub);
		assert.equal(await core.getRootDir(sub), root);
	} finally {
		fs.removeSync(root);
	}
});

test('returns the nearest root when markers nest', async () => {
	const outer = tmpTree();
	try {
		fs.writeFileSync(path.join(outer, '.wonderpressrc'), '{}');
		const inner = path.join(outer, 'sites', 'inner');
		fs.ensureDirSync(inner);
		fs.writeFileSync(path.join(inner, '.wonderpressrc'), '{}');

		assert.equal(await core.getRootDir(path.join(inner, 'wp-content')), inner);
	} finally {
		fs.removeSync(outer);
	}
});

test('terminates and returns false when no marker exists anywhere above', async () => {
	const root = tmpTree();
	try {
		const deep = path.join(root, 'a', 'b', 'c');
		fs.ensureDirSync(deep);

		// The old loop relied on a 50-iteration cap to stop; the fixed one
		// terminates on path.dirname reaching its fixpoint at the filesystem
		// root. If that is wrong this test hangs rather than failing.
		assert.equal(await core.getRootDir(deep), false);
	} finally {
		fs.removeSync(root);
	}
});

test('never resolves the root to the home directory', async () => {
	// A stand-in for $HOME, so the rule can be covered without writing a
	// .wonderpressrc into the developer's real home directory.
	const home = tmpTree();
	try {
		fs.writeFileSync(path.join(home, '.wonderpressrc'), '{}');
		const sub = path.join(home, 'projects', 'something');
		fs.ensureDirSync(sub);

		// A stray ~/.wonderpressrc must not make every directory beneath the
		// home dir look like an environment root — that would point `lint` at
		// $HOME and run phpcs against it.
		assert.equal(await core.getRootDir(sub, { home }), false);
	} finally {
		fs.removeSync(home);
	}
});

test('a real root below the home directory is still found', async () => {
	// The $HOME exclusion skips that one directory; it must not abandon the
	// walk, or no environment in ~/projects/ would ever resolve.
	const home = tmpTree();
	try {
		fs.writeFileSync(path.join(home, '.wonderpressrc'), '{}');
		const site = path.join(home, 'projects', 'my-site');
		fs.ensureDirSync(path.join(site, 'wp-content'));
		fs.writeFileSync(path.join(site, '.wonderpressrc'), '{}');

		assert.equal(await core.getRootDir(path.join(site, 'wp-content'), { home }), site);
	} finally {
		fs.removeSync(home);
	}
});
