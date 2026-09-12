import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWpCliCommand, quoteArg, toResult } from '../src/env/command.js';

/**
 * The pure half of the backend seam.
 *
 * These matter more than their size suggests: the whole design rests on the
 * difference between backends being one array of leading tokens, and on
 * `toResult` not silently breaking the call sites that used to stringify
 * shelljs's output.
 **/

test('quoteArg leaves shell-safe arguments untouched', () => {
	// Byte-identical output for the ordinary case is what makes the host
	// backend a no-op refactor rather than a rewrite.
	for (const safe of ['wp', 'theme', 'activate', 'wonderpress', '--format=json', '--status=active', './wp-content', 'a-b_c.d', 'user@example.com', '50%']) {
		assert.equal(quoteArg(safe), safe, `${safe} should not be quoted`);
	}
});

test('quoteArg quotes what a shell would otherwise mangle', () => {
	assert.equal(quoteArg('My Site'), "'My Site'");
	assert.equal(quoteArg('p$ssw0rd'), "'p$ssw0rd'");
	assert.equal(quoteArg('a;rm -rf b'), "'a;rm -rf b'");
	assert.equal(quoteArg('back`tick`'), "'back`tick`'");
	assert.equal(quoteArg('semi&&colon'), "'semi&&colon'");
});

test('quoteArg survives an embedded single quote', () => {
	// The one case naive single-quoting gets wrong.
	assert.equal(quoteArg("it's"), `'it'\\''s'`);
});

test('quoteArg preserves an empty argument', () => {
	// An unquoted empty string vanishes from the argv, which would silently
	// shift every flag after it.
	assert.equal(quoteArg(''), "''");
});

test('buildWpCliCommand prefixes a string command as-is', () => {
	assert.equal(
		buildWpCliCommand(['wp'], 'theme list --format=json'),
		'wp theme list --format=json'
	);
});

test('buildWpCliCommand quotes an array command element by element', () => {
	assert.equal(
		buildWpCliCommand(['wp'], ['theme', 'activate', 'wonderpress']),
		'wp theme activate wonderpress'
	);
	assert.equal(
		buildWpCliCommand(['wp'], ['option', 'update', 'blogname', 'My Site']),
		"wp option update blogname 'My Site'"
	);
});

test('buildWpCliCommand carries a multi-token prefix', () => {
	// This is the entire difference between the two backends.
	assert.equal(
		buildWpCliCommand(['/path/to/wp-env', 'run', 'cli', 'wp'], ['theme', 'list', '--format=json']),
		'/path/to/wp-env run cli wp theme list --format=json'
	);
});

test('buildWpCliCommand quotes a prefix token that needs it', () => {
	assert.equal(
		buildWpCliCommand(['/Users/a b/node_modules/.bin/wp-env', 'stop'], ''),
		"'/Users/a b/node_modules/.bin/wp-env' stop"
	);
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
