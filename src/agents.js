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
import { listPageTemplates } from './template.js';
import { isValidNamespace, LEGACY_NAMESPACE } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(__dirname, 'templates/agents.md.mustache');

const CLAUDE_STUB = 'Read AGENTS.md in this directory. It is the WonderPress agent contract for this project.\n';

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
		? listPageTemplates(themeDir).map((row) => ({
			template: row.template,
			lock: row.lock === false ? 'false' : String(row.lock),
			sections: row.sections,
		}))
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
 * Write AGENTS.md (canonical) and CLAUDE.md (pointer) at the environment root.
 **/
export function writeAgentFiles({ root, themeDir }) {
	const envRoot = root || process.cwd();
	const view = buildAgentView({ root: envRoot, themeDir });
	const template = fs.readFileSync(TEMPLATE, 'utf8');
	const body = mustache.render(template, view).replace(/\n+$/, '\n');

	fs.writeFileSync(path.join(envRoot, 'AGENTS.md'), body);
	fs.writeFileSync(path.join(envRoot, 'CLAUDE.md'), CLAUDE_STUB);
	return {
		agents: path.join(envRoot, 'AGENTS.md'),
		claude: path.join(envRoot, 'CLAUDE.md'),
		view,
	};
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

	const written = writeAgentFiles({ root, themeDir });
	log.success(`Wrote ${written.agents}`);
	log.success(`Wrote ${written.claude}`);
	if (format.isJson()) {
		return format.ok({
			agents: written.agents,
			claude: written.claude,
			theme: written.view.theme_name,
			partials: written.view.partials.length,
			templates: written.view.templates.length,
		});
	}
	return true;
}
