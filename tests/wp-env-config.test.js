import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWpEnvConfig, portFromUrl, splitForWpEnv, resolveWpEnvBin } from '../src/env/wp-env.js';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

/**
 * The pure parts of the wp-env backend — every one of these pins a fact that
 * was verified against @wordpress/env 11 by hand, so a future edit that
 * quietly undoes one fails here rather than in a ten-minute Docker job.
 **/

test('the generated config carries the values that matter', () => {
	const c = buildWpEnvConfig();

	// "." mounts the whole project at /var/www/html, which is what makes
	// `mappings` unnecessary and keeps host phpcs pointed at the same files.
	assert.equal(c.core, '.');

	// Not cosmetic: the deprecated default makes wp-env recursively copy the
	// entire project into ~/.wp-env on every config-changing start.
	assert.equal(c.testsEnvironment, false);

	assert.equal(c.phpVersion, '8.2');

	// autoPort is force-disabled when CI is set, so enabling it would make
	// local and CI disagree about the site URL.
	assert.equal(c.autoPort, undefined);

	// Deprecated, and meaningless with the tests environment off.
	assert.equal(c.testsPort, undefined);
});

test('the port is overridable and defaults to 8888', () => {
	assert.equal(buildWpEnvConfig().port, 8888);
	assert.equal(buildWpEnvConfig({ port: 8080 }).port, 8080);
});

test('a port is lifted out of a --wp-url', () => {
	assert.equal(portFromUrl('localhost:8080'), 8080);
	assert.equal(portFromUrl('http://localhost:3000/'), 3000);
	assert.equal(portFromUrl('wonderpress.localhost'), null);
	assert.equal(portFromUrl(undefined), null);
});

test('flags are passed through the -- separator', () => {
	// Without it, a --debug or --config meant for wp is eaten by wp-env's own
	// option parser.
	assert.deepEqual(
		splitForWpEnv(['theme', 'list', '--format=json']),
		['theme', 'list', '--', '--format=json']
	);
});

test('a command with no flags gets no separator', () => {
	assert.deepEqual(splitForWpEnv(['core', 'is-installed']), ['core', 'is-installed']);
});

test('only the first flag introduces the separator', () => {
	assert.deepEqual(
		splitForWpEnv(['user', 'update', 'admin', '--user_email=a@b.c', '--user_pass=x']),
		['user', 'update', 'admin', '--', '--user_email=a@b.c', '--user_pass=x']
	);
});

test('a project-local wp-env is preferred over anything global', () => {
	// Matches wp-env's own precedence: its bin already redirects to a local
	// copy when one exists.
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-bin-')));
	try {
		const bin = path.join(dir, 'node_modules', '.bin', 'wp-env');
		fs.ensureDirSync(path.dirname(bin));
		fs.writeFileSync(bin, '#!/bin/sh\n');

		assert.equal(resolveWpEnvBin(dir), bin);
	} finally { fs.removeSync(dir); }
});

test('resolution reports failure rather than guessing a path', () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-bin-')));
	try {
		const resolved = resolveWpEnvBin(dir);
		// Either a real global install, or false — never a fabricated path.
		assert.ok(resolved === false || fs.existsSync(resolved));
	} finally { fs.removeSync(dir); }
});
