import fs from 'fs-extra';
import path from 'path';
import mustache from 'mustache';
import { fileURLToPath } from 'url';
import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import * as core from './core.js';
import * as config from './config.js';
import * as partial from './partial.js';
import { listPageTemplates, findPageTemplateManifest } from './template.js';
import { flattenTemplateComposition, isValidNamespace, LEGACY_NAMESPACE } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, 'templates/agents.md.mustache');
const CLI_BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

const CLAUDE_STUB = 'Read AGENTS.md in this directory. It is the WonderPress agent contract for this project.\n';

const MCP_CONFIGS = [
	{ rel: '.mcp.json', key: 'mcpServers', extra: {}, host: 'claude' },
	{ rel: path.join('.cursor', 'mcp.json'), key: 'mcpServers', extra: {}, host: 'cursor' },
	{ rel: path.join('.vscode', 'mcp.json'), key: 'servers', extra: { type: 'stdio' }, host: 'vscode' },
];

export const MCP_GITIGNORE_PATTERNS = [
	'.mcp.json',
	'.cursor/mcp.json',
	'.vscode/mcp.json',
	'.codex/config.toml',
];

/**
 * Stdio MCP entry that pins the Node which wrote this config.
 *
 * GUI hosts (Cursor, VS Code) often spawn with their own Node. Using
 * process.execPath + the absolute CLI bin avoids PATH gaps and arch
 * mismatches against native addons installed under that Node.
 **/
export function buildMcpStdio(envRoot) {
	return {
		command: process.execPath,
		args: [CLI_BIN, 'mcp'],
		cwd: path.resolve(envRoot),
	};
}

export function buildCursorInstallLink(stdio) {
	const config = Buffer.from(JSON.stringify(stdio), 'utf8').toString('base64');
	return `cursor://anysphere.cursor-deeplink/mcp/install?name=wonderpress&config=${encodeURIComponent(config)}`;
}

function gitignoreHasPattern(body, pattern) {
	return body.split(/\r?\n/).some((line) => {
		const trimmed = line.trim();
		return trimmed === pattern || trimmed === `/${pattern}`;
	});
}

/**
 * Append ignore rules for machine-local MCP host configs (absolute pins).
 * AGENTS.md and CLAUDE.md stay committable.
 **/
export function ensureMcpGitignore(root) {
	const file = path.join(root, '.gitignore');
	let body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
	const missing = MCP_GITIGNORE_PATTERNS.filter((pattern) => !gitignoreHasPattern(body, pattern));
	if (!missing.length) {
		return { file, added: [], skipped: true };
	}
	if (body && !body.endsWith('\n')) {
		body += '\n';
	}
	const block = [
		'',
		'# Machine-local MCP host configs (absolute Node/CLI/cwd pins). Keep AGENTS.md.',
		...missing,
		'',
	].join('\n');
	fs.writeFileSync(file, body + block);
	return { file, added: missing, skipped: false };
}

function renderCodexWonderpressTable(stdio) {
	const args = stdio.args.map((arg) => JSON.stringify(arg)).join(', ');
	return [
		'[mcp_servers.wonderpress]',
		`command = ${JSON.stringify(stdio.command)}`,
		`args = [${args}]`,
		`cwd = ${JSON.stringify(stdio.cwd)}`,
		'',
	].join('\n');
}

function hasCodexWonderpressTable(raw) {
	return /^\s*\[mcp_servers\.wonderpress\]\s*$/m.test(raw);
}

function spliceCodexWonderpressTable(raw, table) {
	const header = '[mcp_servers.wonderpress]';
	const start = raw.indexOf(header);
	if (start === -1) {
		const prefix = raw.endsWith('\n') || raw === '' ? raw : `${raw}\n`;
		const gap = prefix === '' || prefix.endsWith('\n\n') ? '' : '\n';
		return `${prefix}${gap}${table}`;
	}
	const after = start + header.length;
	const next = raw.slice(after).search(/\n\[/);
	const end = next === -1 ? raw.length : after + next + 1;
	return `${raw.slice(0, start)}${table}${raw.slice(end)}`;
}

export function upsertWonderpressCodexConfig(file, { envRoot, force = false }) {
	const table = renderCodexWonderpressTable(buildMcpStdio(envRoot));
	if (fs.existsSync(file)) {
		const raw = fs.readFileSync(file, 'utf8');
		if (hasCodexWonderpressTable(raw) && !force) {
			return { file, skipped: true, preserved: true, host: 'codex' };
		}
		fs.writeFileSync(file, spliceCodexWonderpressTable(raw, table));
		return { file, skipped: false, preserved: false, host: 'codex' };
	}
	fs.ensureDirSync(path.dirname(file));
	fs.writeFileSync(file, table);
	return { file, skipped: false, preserved: false, host: 'codex' };
}

function propertyIndex(properties = []) {
	return properties
		.filter((p) => p && p.name)
		.map((p) => `${p.name}:${p.type || 'string'}`)
		.join(', ');
}

function themeSlug(themeDir) {
	return path.basename(themeDir || '');
}

/**
 * Build the view model for AGENTS.md from manifests on disk.
 **/
export function buildAgentView({ root, themeDir }) {
	const recorded = config.read(root || process.cwd()).data.namespace;
	const namespace = isValidNamespace(recorded)
		? recorded
		: (themeDir ? partial.resolveNamespace(themeDir, root) : LEGACY_NAMESPACE);

	const partials = themeDir
		? partial.readManifests(themeDir)
			.slice()
			.sort((a, b) => a.slug.localeCompare(b.slug))
			.map((manifest) => ({
				slug: manifest.slug,
				name: manifest.name,
				block: manifest.block || false,
				acf: !!manifest.acf_compatible,
				props: propertyIndex(manifest.properties),
			}))
		: [];

	const templates = themeDir
		? listPageTemplates(themeDir).map((row) => {
			const found = findPageTemplateManifest(themeDir, row.template);
			const composition = found?.manifest?.composition || [];
			const ids = flattenTemplateComposition(composition).map((item) => (
				item.partial ? `${item.id}:${item.partial}` : item.id
			));
			return {
				template: row.template,
				lock: row.lock === false ? 'false' : String(row.lock),
				sections: row.sections,
				index: ids.join(', ') || '(empty)',
			};
		})
		: [];

	return {
		has_project: !!themeDir && fs.existsSync(themeDir),
		theme_name: themeDir ? themeSlug(themeDir) : '',
		namespace,
		partials,
		templates,
	};
}

/**
 * Merge the WonderPress stdio server into an MCP client config.
 *
 * Other servers in the file are left alone. An unparseable file is skipped
 * rather than overwritten — that is someone else's config, not ours to clobber.
 *
 * An existing `wonderpress` entry is left as-is unless `force` is set. Editors
 * key their "trust this server" prompt on the config contents, so rewriting an
 * entry that already works makes the user re-approve it.
 **/
export function upsertWonderpressMcpConfig(file, { key, extra = {}, envRoot, force = false, host }) {
	let data = {};
	if (fs.existsSync(file)) {
		try {
			data = JSON.parse(fs.readFileSync(file, 'utf8'));
			if (!data || typeof data !== 'object' || Array.isArray(data)) {
				throw new Error('expected a JSON object');
			}
		} catch (err) {
			log.warn(`Skipping ${file}: could not parse existing MCP config (${err.message}).`);
			return { file, skipped: true, preserved: false, host };
		}
	}

	if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) {
		data[key] = {};
	}

	const existing = data[key].wonderpress;
	if (!force && existing && typeof existing === 'object' && !Array.isArray(existing)) {
		return { file, skipped: true, preserved: true, host };
	}

	data[key].wonderpress = { ...extra, ...buildMcpStdio(envRoot) };

	fs.ensureDirSync(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
	return { file, skipped: false, preserved: false, host };
}

/**
 * Write AGENTS.md (canonical), CLAUDE.md (pointer), and host MCP configs.
 **/
export function writeAgentFiles({ root, themeDir, force = false }) {
	const envRoot = path.resolve(root || process.cwd());
	const view = buildAgentView({ root: envRoot, themeDir });
	const template = fs.readFileSync(TEMPLATE, 'utf8');
	const body = mustache.render(template, view).replace(/\n+$/, '\n');

	fs.writeFileSync(path.join(envRoot, 'AGENTS.md'), body);
	fs.writeFileSync(path.join(envRoot, 'CLAUDE.md'), CLAUDE_STUB);

	const gitignore = ensureMcpGitignore(envRoot);
	const mcp = MCP_CONFIGS.map((spec) => (
		upsertWonderpressMcpConfig(path.join(envRoot, spec.rel), { ...spec, envRoot, force })
	));
	mcp.push(upsertWonderpressCodexConfig(path.join(envRoot, '.codex/config.toml'), { envRoot, force }));

	return {
		agents: path.join(envRoot, 'AGENTS.md'),
		claude: path.join(envRoot, 'CLAUDE.md'),
		gitignore,
		mcp,
		view,
	};
}

function announceHostSetup(mcp) {
	const fresh = mcp.filter((entry) => !entry.skipped && !entry.preserved);
	if (!fresh.length) {
		return;
	}
	const hosts = new Set(fresh.map((entry) => entry.host));
	if (hosts.has('cursor')) {
		const cursor = fresh.find((entry) => entry.host === 'cursor');
		let stdio;
		try {
			stdio = JSON.parse(fs.readFileSync(cursor.file, 'utf8')).mcpServers.wonderpress;
		} catch {
			stdio = null;
		}
		log.info('Cursor: enable wonderpress in Customize → MCPs, or open:');
		log.raw(stdio ? buildCursorInstallLink(stdio) : 'cursor://anysphere.cursor-deeplink/mcp/install?name=wonderpress');
	}
	if (hosts.has('claude')) {
		log.info('Claude Code: run `claude` in this directory to approve the project MCP server.');
	}
	if (hosts.has('vscode')) {
		log.info('VS Code: enable the wonderpress server in MCP settings.');
	}
	if (hosts.has('codex')) {
		log.info('Codex: trust this folder, then `codex mcp list`.');
	}
}

export async function command(subcommand, args) {
	switch (subcommand) {
		case 'write':
			await write(args);
			break;
		default:
			if (subcommand) {
				log.error(`Unknown agents subcommand: ${subcommand}`);
				process.exitCode = format.EXIT_FAIL;
				format.fail({
					code: 'unknown_command',
					message: `Unknown agents subcommand: ${subcommand}`,
					hint: 'Run `wonderpress agents help`.',
				});
			}
			help.show('agents');
			break;
	}

	return true;
}

export async function write(args) {
	const dir = args['--dir'] || process.cwd();
	process.chdir(dir);

	if (!await core.setCwdToEnvironmentRoot()) {
		return format.fail({
			code: 'env',
			message: 'Not a Wonderpress environment root',
			hint: 'Run from the project root, or pass --dir.',
		});
	}

	const root = process.cwd();
	let themeDir = null;
	if (args['--theme']) {
		themeDir = path.join(root, 'wp-content/themes', args['--theme']);
	} else {
		const themesRoot = path.join(root, 'wp-content/themes');
		if (fs.existsSync(themesRoot)) {
			const names = fs.readdirSync(themesRoot).filter((name) => {
				const p = path.join(themesRoot, name);
				return fs.statSync(p).isDirectory() && !name.startsWith('.');
			});
			if (names.length === 1) {
				themeDir = path.join(themesRoot, names[0]);
			} else if (names.length > 1) {
				try {
					themeDir = await partial.resolveThemeDir({ '--dir': root });
				} catch {
					themeDir = null;
				}
			}
		}
	}

	const written = writeAgentFiles({ root, themeDir, force: !!args['--force'] });

	// One report for the whole write. Every line here used to carry a verb —
	// "Wrote", and four repetitions of "Kept existing wonderpress server in" —
	// which said what the glyph says: a check wrote it, a dot left it alone.
	log.group([
		{ level: 'success', path: written.agents },
		{ level: 'success', path: written.claude },
		written.gitignore?.added?.length
			? { level: 'success', path: written.gitignore.file, hint: written.gitignore.added.join(', ') }
			: null,
		...written.mcp
			// A preserved entry is also marked skipped, so `preserved` has to be
			// asked first: the only entries worth hiding are the unparseable ones,
			// which warned for themselves on the way past.
			.filter((entry) => entry.preserved || !entry.skipped)
			.map((entry) => (entry.preserved
				? { level: 'info', path: entry.file, hint: '--force to rewrite' }
				: { level: 'success', path: entry.file })),
	]);
	announceHostSetup(written.mcp);
	if (format.isJson()) {
		return format.ok({
			agents: written.agents,
			claude: written.claude,
			gitignore: written.gitignore,
			mcp: written.mcp,
			theme: written.view.theme_name,
			partials: written.view.partials.length,
			templates: written.view.templates.length,
		});
	}
	return true;
}
