import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWpCliArgv, toResult } from '../src/env/command.js';

/**
 * The pure half of the backend seam.
 *
 * These matter more than their size suggests: the whole design rests on the
 * difference between backends being one array of leading tokens, and on
 * `toResult` not silently breaking the call sites that used to stringify
 * shelljs's output.
 **/

test('buildWpCliArgv keeps an array command as argv, element by element', () => {
	assert.deepEqual(buildWpCliArgv(['wp'], ['theme', 'activate', 'wonderpress']), {
		file: 'wp',
		args: ['theme', 'activate', 'wonderpress'],
	});
	// Nothing is quoted or escaped: no shell will ever parse these.
	assert.deepEqual(buildWpCliArgv(['wp'], ['option', 'update', 'blogname', "Tom's $HOME & 100%"]).args, ['option', 'update', 'blogname', "Tom's $HOME & 100%"]);
});

test('buildWpCliArgv splits a string command on whitespace', () => {
	assert.deepEqual(buildWpCliArgv(['wp'], 'theme list  --format=json'), {
		file: 'wp',
		args: ['theme', 'list', '--format=json'],
	});
	assert.deepEqual(buildWpCliArgv('wp', '').args, []);
});

test('buildWpCliArgv carries a multi-token prefix, spaces in the binary path included', () => {
	assert.deepEqual(buildWpCliArgv(['/Users/a b/node_modules/.bin/wp-env', 'run', 'cli', 'wp'], ['theme', 'list', '--format=json']), {
		file: '/Users/a b/node_modules/.bin/wp-env',
		args: ['run', 'cli', 'wp', 'theme', 'list', '--format=json'],
	});
});

test('toResult normalizes a shelljs result', () => {
	const result = toResult({ code: 0, stdout: '[]\n', stderr: '' });

	assert.equal(result.code, 0);
	assert.equal(result.stdout, '[]\n');
	assert.equal(result.stderr, '');
});

test('toResult stringifies to stdout', () => {
	// shelljs's ShellString stringifies this way and call sites relied on it
	// (`JSON.parse(sh.exec(...))`). A bare object would make those
	// `JSON.parse("[object Object]")` — and getAllThemes() swallows parse
	// errors, so the symptom would be init quietly ceasing to activate themes.
	const result = toResult({ code: 0, stdout: '[{"name":"wonderpress"}]', stderr: '' });

	assert.deepEqual(JSON.parse(`${result}`), [{ name: 'wonderpress' }]);
});

test('toResult treats a missing result as a failure', () => {
	const result = toResult(undefined);

	assert.equal(result.code, 1);
	assert.equal(result.stdout, '');
});
