import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnvelope } from '../src/format.js';
import { writeAgentFiles, buildAgentView } from '../src/agents.js';
import { writePartial, paramsFromFlags } from '../src/partial.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

function makeEnv() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-agents-'));
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
	const themeDir = path.join(root, 'wp-content/themes/acme');
	fs.ensureDirSync(path.join(themeDir, 'src/partials'));
	fs.ensureDirSync(path.join(themeDir, 'partials'));
	return { root, themeDir };
}

test('writeAgentFiles is stable and indexes partials', async () => {
	const { root, themeDir } = makeEnv();
	try {
		await writePartial(paramsFromFlags({
			'--name': 'Hero',
			'--block': true,
			'--prop': ['title:string:required', 'image:image'],
		}), themeDir);

		const first = writeAgentFiles({ root, themeDir });
		const second = writeAgentFiles({ root, themeDir });
		assert.equal(fs.readFileSync(first.agents, 'utf8'), fs.readFileSync(second.agents, 'utf8'));
		assert.equal(fs.readFileSync(first.claude, 'utf8'), 'Read AGENTS.md in this directory. It is the WonderPress agent contract for this project.\n');

		const md = fs.readFileSync(first.agents, 'utf8');
		assert.match(md, /`hero` \(Hero\) — block `acme\/hero`/);
		assert.match(md, /title:string/);
		assert.match(md, /partial sync/);
		assert.doesNotMatch(md, /\d{4}-\d{2}-\d{2}/);
	} finally {
		fs.removeSync(root);
	}
});

test('wonderpress agents write --format json', () => {
	const { root } = makeEnv();
	try {
		const result = spawnSync('node', [BIN, 'agents', 'write', '--dir', root, '--theme', 'acme', '--format', 'json'], { encoding: 'utf8' });
		const body = parseEnvelope(result.stdout);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(body.ok, true);
		assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
		assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
	} finally {
		fs.removeSync(root);
	}
});

test('buildAgentView sorts partials', async () => {
	const { root, themeDir } = makeEnv();
	try {
		await writePartial(paramsFromFlags({ '--name': 'Zebra' }), themeDir);
		await writePartial(paramsFromFlags({ '--name': 'Alpha' }), themeDir);
		const view = buildAgentView({ root, themeDir });
		assert.deepEqual(view.partials.map((p) => p.slug), ['alpha', 'zebra']);
	} finally {
		fs.removeSync(root);
	}
});
