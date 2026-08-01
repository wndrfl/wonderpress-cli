import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInitConfig, resolve } from '../src/init-config.js';

test('resolve: flag ?? env ?? fallback (empty env counts as absent)', () => {
	assert.equal(resolve('f', 'e', 'd'), 'f');
	assert.equal(resolve(undefined, 'e', 'd'), 'e');
	assert.equal(resolve(undefined, '', 'd'), 'd');
	assert.equal(resolve(undefined, undefined, 'd'), 'd');
	assert.equal(resolve(null, null, 'd'), 'd');
});

test('interactive mode leaves unprovided fields undefined', () => {
	const c = resolveInitConfig({}, {});
	assert.equal(c.interactive, true);
	assert.equal(c.db.host, undefined);
	assert.equal(c.wp.adminPassword, undefined);
});

test('--yes fills defaults for every field', () => {
	const c = resolveInitConfig({ '--yes': true }, {});
	assert.equal(c.interactive, false);
	assert.equal(c.db.host, 'localhost');
	assert.equal(c.db.name, 'wonderpress');
	assert.equal(c.wp.adminPassword, 'supersecure');
});

test('flags win over env/defaults; env used for secrets', () => {
	const c = resolveInitConfig(
		{ '--yes': true, '--db-host': 'flaghost' },
		{ WP_ADMIN_PASSWORD: 'envpass', WP_DB_NAME: 'envdb' },
	);
	assert.equal(c.db.host, 'flaghost');
	assert.equal(c.wp.adminPassword, 'envpass');
	assert.equal(c.db.name, 'envdb');
});

test('theme / skipReadme / cleanSlate flags surface on the config', () => {
	const c = resolveInitConfig({ '--yes': true, '--theme': 'mytheme', '--skip-readme': true, '--clean-slate': true }, {});
	assert.equal(c.theme, 'mytheme');
	assert.equal(c.skipReadme, true);
	assert.equal(c.cleanSlate, true);
});
