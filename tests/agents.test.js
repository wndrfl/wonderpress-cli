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

		const ptDir = path.join(themeDir, '.wonderpress/manifest/page-templates');
		fs.ensureDirSync(ptDir);
		fs.writeFileSync(path.join(ptDir, 'template-landing.json'), JSON.stringify({
			schemaVersion: 1,
			template: 'template-landing.php',
			editor: { lock: 'all' },
			composition: [{ id: 'hero-main', partial: 'hero' }],
		}) + '\n');

		const first = writeAgentFiles({ root, themeDir });
		const second = writeAgentFiles({ root, themeDir });
		assert.equal(fs.readFileSync(first.agents, 'utf8'), fs.readFileSync(second.agents, 'utf8'));
		assert.equal(fs.readFileSync(first.claude, 'utf8'), 'Read AGENTS.md in this directory. It is the WonderPress agent contract for this project.\n');

		const md = fs.readFileSync(first.agents, 'utf8');
		assert.match(md, /`hero` \(Hero\) — block `acme\/hero`/);
		assert.match(md, /title:string/);
		assert.match(md, /partial sync/);
		assert.match(md, /How to continue a page template/);
		assert.match(md, /wonder_partial_props/);
		assert.match(md, /wonder_template_composition_field/);
		assert.match(md, /`template-landing.php` — lock `all` — hero-main:hero/);
		assert.doesNotMatch(md, /\d{4}-\d{2}-\d{2}/);

		const cursor = JSON.parse(fs.readFileSync(path.join(root, '.cursor/mcp.json'), 'utf8'));
		assert.equal(cursor.mcpServers.wonderpress.command, process.execPath);
		assert.equal(cursor.mcpServers.wonderpress.args[1], 'mcp');
		assert.match(cursor.mcpServers.wonderpress.args[0], /bin[/\\]wonderpress\.js$/);
		assert.equal(cursor.mcpServers.wonderpress.cwd, path.resolve(root));
		const vscode = JSON.parse(fs.readFileSync(path.join(root, '.vscode/mcp.json'), 'utf8'));
		assert.equal(vscode.servers.wonderpress.type, 'stdio');
		assert.equal(vscode.servers.wonderpress.command, process.execPath);
		assert.equal(vscode.servers.wonderpress.cwd, path.resolve(root));
		const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
		assert.match(ignore, /^\.cursor\/mcp\.json$/m);
		assert.match(ignore, /^\.codex\/config\.toml$/m);
		const codex = fs.readFileSync(path.join(root, '.codex/config.toml'), 'utf8');
		assert.match(codex, /\[mcp_servers\.wonderpress\]/);
		assert.match(codex, /bin[/\\]wonderpress\.js/);
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
		assert.equal(body.data.mcp.length, 4);
		assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')));
		assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
		assert.ok(fs.existsSync(path.join(root, '.mcp.json')));
		assert.ok(fs.existsSync(path.join(root, '.cursor/mcp.json')));
		assert.ok(fs.existsSync(path.join(root, '.vscode/mcp.json')));
		assert.ok(fs.existsSync(path.join(root, '.codex/config.toml')));
		assert.ok(body.data.gitignore.added.includes('.mcp.json'));
	} finally {
		fs.removeSync(root);
	}
});

test('writeAgentFiles merges wonderpress into existing MCP configs', () => {
	const { root, themeDir } = makeEnv();
	try {
		fs.ensureDirSync(path.join(root, '.cursor'));
		fs.writeFileSync(path.join(root, '.cursor/mcp.json'), JSON.stringify({
			mcpServers: {
				other: { command: 'other' },
			},
		}) + '\n');
		fs.writeFileSync(path.join(root, '.mcp.json'), 'not json');

		writeAgentFiles({ root, themeDir });

		const cursor = JSON.parse(fs.readFileSync(path.join(root, '.cursor/mcp.json'), 'utf8'));
		assert.equal(cursor.mcpServers.other.command, 'other');
		assert.equal(cursor.mcpServers.wonderpress.args[1], 'mcp');
		assert.match(cursor.mcpServers.wonderpress.args[0], /bin[/\\]wonderpress\.js$/);
		assert.equal(cursor.mcpServers.wonderpress.command, process.execPath);
		assert.equal(cursor.mcpServers.wonderpress.cwd, path.resolve(root));
		assert.equal(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'), 'not json');
	} finally {
		fs.removeSync(root);
	}
});

test('writeAgentFiles keeps an existing wonderpress entry unless forced', () => {
	const { root, themeDir } = makeEnv();
	try {
		const file = path.join(root, '.cursor/mcp.json');
		const hand = { command: 'wonderpress', args: ['mcp'] };
		fs.ensureDirSync(path.join(root, '.cursor'));
		fs.writeFileSync(file, JSON.stringify({ mcpServers: { wonderpress: hand } }) + '\n');

		writeAgentFiles({ root, themeDir });
		assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.wonderpress, hand);

		writeAgentFiles({ root, themeDir, force: true });
		const forced = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.wonderpress;
		assert.equal(forced.command, process.execPath);
		assert.equal(forced.cwd, path.resolve(root));
	} finally {
		fs.removeSync(root);
	}
});

test('writeAgentFiles keeps an existing Codex wonderpress table unless forced', () => {
	const { root, themeDir } = makeEnv();
	try {
		const file = path.join(root, '.codex/config.toml');
		fs.ensureDirSync(path.join(root, '.codex'));
		fs.writeFileSync(file, '[mcp_servers.other]\ncommand = "other"\n\n[mcp_servers.wonderpress]\ncommand = "hand"\n');

		writeAgentFiles({ root, themeDir });
		const kept = fs.readFileSync(file, 'utf8');
		assert.match(kept, /command = "hand"/);
		assert.match(kept, /\[mcp_servers\.other\]/);

		writeAgentFiles({ root, themeDir, force: true });
		const forced = fs.readFileSync(file, 'utf8');
		assert.match(forced, /\[mcp_servers\.other\]/);
		assert.doesNotMatch(forced, /command = "hand"/);
		assert.match(forced, /bin[/\\]wonderpress\.js/);
	} finally {
		fs.removeSync(root);
	}
});

test('writeAgentFiles does not duplicate gitignore MCP patterns', () => {
	const { root, themeDir } = makeEnv();
	try {
		writeAgentFiles({ root, themeDir });
		writeAgentFiles({ root, themeDir });
		const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
		assert.equal(ignore.split('.cursor/mcp.json').length - 1, 1);
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
