import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { handlers, createWonderpressMcpServer } from '../src/mcp.js';
import { writePartial, paramsFromFlags, listPartials } from '../src/partial.js';

function makeEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mcp-'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
	const themeDir = path.join(root, 'wp-content/themes/acme');
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	return { root, themeDir };
}

function parse(result) {
	return JSON.parse(result.content[0].text);
}

test('MCP server registers the planned tools', () => {
	const server = createWonderpressMcpServer();
	assert.ok(server);
});

test('partial_create then partial_get match CLI --json create', async () => {
	const { root } = makeEnv();
	const cwd = process.cwd();
	try {
		process.chdir(root);
		const created = parse(await handlers.partial_create({
			dir: root,
			theme: 'acme',
			spec: { name: 'Quote', block: true, properties: [{ name: 'body', type: 'string', required: true }] },
		}));
		assert.equal(created.ok, true);
		assert.equal(created.slug, 'quote');

		const got = parse(await handlers.partial_get({ dir: root, theme: 'acme', slug: 'quote' }));
		assert.equal(got.ok, true);
		assert.equal(got.manifest.slug, 'quote');
		assert.equal(got.manifest.block, 'acme/quote');

		const listed = parse(await handlers.partial_list({ dir: root, theme: 'acme' }));
		assert.equal(listed.partials.length, 1);

		const viaFlags = path.join(root, 'wp-content/themes/acme');
		assert.equal(listPartials(viaFlags)[0].slug, 'quote');
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});

test('partial_remove requires confirm', async () => {
	const { root, themeDir } = makeEnv();
	const cwd = process.cwd();
	try {
		process.chdir(root);
		await writePartial(paramsFromFlags({ '--name': 'Hero' }), themeDir);
		const refused = parse(await handlers.partial_remove({ dir: root, theme: 'acme', name: 'Hero' }));
		assert.equal(refused.ok, false);
		assert.match(refused.error.message, /confirm/);
		assert.ok(fs.existsSync(path.join(themeDir, 'src/partials/class-hero.php')));

		const removed = parse(await handlers.partial_remove({ dir: root, theme: 'acme', name: 'Hero', confirm: true }));
		assert.equal(removed.ok, true);
		assert.ok(!fs.existsSync(path.join(themeDir, 'src/partials/class-hero.php')));
	} finally {
		process.chdir(cwd);
		fs.removeSync(root);
	}
});
