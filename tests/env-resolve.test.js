import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBackendName } from '../src/env/index.js';

/**
 * Backend resolution precedence. Pure, so the whole table is cheap to pin.
 *
 * The tier that matters most is the last one: an environment with no markers
 * of any kind resolves to `host`. Every WonderPress site built before this
 * feature existed is in exactly that state, and must keep using the backend it
 * has always used.
 **/

test('an environment with no markers resolves to host', () => {
	const r = resolveBackendName({});
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'default');
});

test('undefined inputs resolve to host rather than throwing', () => {
	assert.equal(resolveBackendName().name, 'host');
	assert.equal(resolveBackendName({ flag: undefined, envVar: undefined, persisted: undefined, detected: undefined }).name, 'host');
});

test('the flag wins over everything', () => {
	const r = resolveBackendName({ flag: 'host', envVar: 'wp-env', persisted: 'wp-env', detected: 'wp-env' });
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'flag');
});

test('the env var wins over what is recorded', () => {
	const r = resolveBackendName({ envVar: 'host', persisted: 'wp-env' });
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'env');
});

test('a recorded backend wins over detection', () => {
	const r = resolveBackendName({ persisted: 'host', detected: 'wp-env' });
	assert.equal(r.name, 'host');
	assert.equal(r.source, 'persisted');
});

test('a .wp-env.json is detected when nothing was recorded', () => {
	// Keeps an environment working after a git checkout reverts .wonderpressrc.
	const r = resolveBackendName({ detected: 'wp-env' });
	assert.equal(r.name, 'wp-env');
	assert.equal(r.source, 'detected');
});

test('an explicit choice contradicting the record is flagged', () => {
	const r = resolveBackendName({ flag: 'host', persisted: 'wp-env' });
	assert.equal(r.mismatch, true);
	assert.equal(r.persisted, 'wp-env');
});

test('agreeing with the record is not a mismatch', () => {
	assert.equal(resolveBackendName({ flag: 'wp-env', persisted: 'wp-env' }).mismatch, false);
});

test('a recorded value alone is never a mismatch', () => {
	// Nothing contradicts it, so there is nothing to warn about.
	assert.equal(resolveBackendName({ persisted: 'wp-env' }).mismatch, false);
});

test('an unknown name is surfaced, not silently ignored', () => {
	const r = resolveBackendName({ flag: 'bogus' });
	assert.equal(r.unknown, 'bogus');
	assert.equal(resolveBackendName({ envVar: 'nope' }).unknown, 'nope');
});

test('an unrecognised recorded value falls back instead of failing', () => {
	// A newer CLI wrote a backend this one does not have: degrade to host
	// rather than refusing to run at all.
	const r = resolveBackendName({ persisted: 'future-backend' });
	assert.equal(r.name, 'host');
	assert.equal(r.unknown, null);
});
