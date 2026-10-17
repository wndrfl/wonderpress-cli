import fs from 'fs-extra';
import path from 'path';
import * as config from './config.js';
import * as core from './core.js';
import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import * as wordpress from './wordpress.js';
import { toPosixPath } from './proc.js';
import { namespaceFromBlocks } from './partial.js';
import {
	isValidNamespace,
	MANIFEST_ROOT,
	PAGE_TEMPLATE_MANIFEST_DIR,
	PARTIAL_MANIFEST_DIR,
} from './validate.js';

/**
 * `wonderpress theme adopt [--theme <name>] [--namespace <ns>]`.
 *
 * Brings a theme built before manifests existed under the CLI's contract. The
 * desktop app recognises a theme only by its `.wonderpress/manifest/` tree,
 * and until now nothing created that tree on purpose: `partial create` made it
 * as a side effect, and a site whose theme predates manifests had no way in
 * short of creating a partial it did not want.
 *
 * Adopt does the minimum: the two manifest directories, and (only when asked)
 * the block namespace in .wonderpressrc. It migrates nothing. Existing partials
 * are counted so the caller can say "3 partials are not under manifests yet",
 * and otherwise left exactly as they are.
 **/

export async function command(subcommand, args) {
	switch (subcommand) {
		case 'adopt':
			await adopt(args);
			break;
		default:
			// Same convention as `partial`: no subcommand shows the group, an
			// unknown one says so first.
			if (subcommand) {
				log.error(`Unknown theme subcommand: ${subcommand}`);
				format.fail({
					code: 'unknown_command',
					message: `Unknown theme subcommand: ${subcommand}`,
					hint: 'Run `wonderpress theme help`.',
				});
			}
			help.show('theme');
			break;
	}

	return true;
}

/**
 * Which theme adopt operates on, from the disk alone.
 *
 * Deliberately not `getActiveTheme()`: a project being adopted may have no
 * reachable database, and a theme that exists on disk is adoptable whether or
 * not WordPress currently runs it. One theme needs no flag; several need
 * --theme, and the error names them so the next invocation can be typed from it.
 *
 * -> { name } | { error }
 **/
export function pickTheme(args, themes) {

	const requested = args['--theme'];

	if (requested) {
		if (!themes.includes(requested)) {
			return {
				error: {
					code: 'theme_not_found',
					message: `No theme named "${requested}" in ${wordpress.pathToThemesDir}`,
					hint: themes.length ? `Themes on disk: ${themes.join(', ')}.` : 'No theme with a style.css was found.',
				},
			};
		}
		return { name: requested };
	}

	if (themes.length === 1) {
		return { name: themes[0] };
	}

	if (themes.length === 0) {
		return {
			error: {
				code: 'no_theme',
				message: `No theme found in ${wordpress.pathToThemesDir}`,
				hint: 'A theme is a directory with a style.css. Nothing here has one.',
			},
		};
	}

	return {
		error: {
			code: 'ambiguous_theme',
			message: `Several themes in ${wordpress.pathToThemesDir}; pass --theme <name>`,
			hint: `Themes on disk: ${themes.join(', ')}.`,
		},
	};
}

/**
 * Directories directly under `<theme>/partials`.
 *
 * A pre-manifest theme kept each partial in its own folder there. They are
 * counted, never read or moved: adopt reports how much is still outside the
 * manifests, and leaves the migration to a later, deliberate step.
 **/
export function countLegacyPartials(themeDir) {

	const dir = path.join(themeDir, 'partials');
	if (!fs.existsSync(dir)) {
		return 0;
	}

	return fs.readdirSync(dir).filter((entry) => {
		const stat = fs.statSync(path.join(dir, entry), { throwIfNoEntry: false });
		return stat !== undefined && stat.isDirectory();
	}).length;
}

/**
 * Do the adoption against a resolved theme directory, with the cwd already at
 * the environment root. Returns the data half of the envelope, or throws
 * nothing: every failure before this point has been reported by the caller.
 *
 * `created` is true when at least one of the two directories did not exist.
 * Running adopt twice is the normal case (the app re-checks), so the second
 * run reports `created: false` and changes nothing.
 **/
export function adoptTheme({ root, themeName, themeDir, namespace }) {

	const dirs = [PARTIAL_MANIFEST_DIR, PAGE_TEMPLATE_MANIFEST_DIR].map((rel) => path.join(themeDir, rel));
	const created = dirs.some((dir) => !fs.existsSync(dir));
	for (const dir of dirs) {
		fs.ensureDirSync(dir);
	}

	let namespaceSource = 'none';
	let resolved = null;

	if (namespace) {
		resolved = namespace;
		namespaceSource = 'rc';
	} else {
		const recorded = config.read(root).data.namespace;
		if (isValidNamespace(recorded)) {
			resolved = recorded;
			namespaceSource = 'rc';
		} else {
			const fromBlocks = namespaceFromBlocks(themeDir);
			if (fromBlocks) {
				resolved = fromBlocks;
				namespaceSource = 'blocks';
			}
		}
	}

	return {
		theme: themeName,
		manifestDir: path.resolve(themeDir, MANIFEST_ROOT),
		created,
		namespace: resolved,
		namespaceSource,
		legacyPartials: countLegacyPartials(themeDir),
	};
}

export async function adopt(args) {

	process.chdir(args['--dir'] ? args['--dir'] : '.');

	if (! await core.setCwdToEnvironmentRoot()) {
		return format.fail({
			code: 'env',
			message: 'This does not appear to be a Wonderpress Development Environment',
			hint: 'Run from inside a project, or pass --dir <root>.',
		});
	}

	const root = process.cwd();

	// Validate the flag before touching anything: a refused namespace must not
	// leave half an adoption behind.
	const namespace = args['--namespace'];
	if (namespace !== undefined && !isValidNamespace(namespace)) {
		log.error(`Invalid namespace "${namespace}": lowercase letters, digits and dashes, starting with a letter.`);
		return format.fail({
			code: 'usage',
			message: `Invalid namespace "${namespace}"`,
			hint: 'Use lowercase letters, digits and dashes, starting with a letter (e.g. acme).',
		}, format.EXIT_USAGE);
	}

	const picked = pickTheme(args, wordpress.themesOnDisk());
	if (picked.error) {
		log.error(`${picked.error.message}. ${picked.error.hint}`);
		return format.fail(picked.error);
	}

	const themeName = picked.name;
	const themeDir = path.join(wordpress.pathToThemesDir, themeName);

	// Record the namespace first: if the rc file cannot be written there is no
	// point creating directories the app will then find without one.
	if (namespace !== undefined) {
		const existing = config.read(root).data.namespace;
		if (isValidNamespace(existing) && existing !== namespace) {
			log.warn(`This project's blocks are namespaced \`${existing}\`, and --namespace asks for \`${namespace}\`.`);
			log.warn(`Blocks already placed on pages stay \`${existing}\` and will stop resolving. Only do this before a site has content.`);
		}
		if (!config.write(root, { namespace })) {
			return format.fail({
				code: 'rc_unwritable',
				message: 'Could not record the namespace in .wonderpressrc',
				hint: 'The file is not JSON. Fix it by hand, then run adopt again.',
			});
		}
	}

	const data = adoptTheme({ root, themeName, themeDir, namespace });

	if (format.isJson()) {
		return format.ok(data);
	}

	// Forward slashes on every OS, matching the paths the CLI prints from manifests.
	const manifestRel = toPosixPath(path.join(themeDir, MANIFEST_ROOT));
	if (data.created) {
		log.success(`Created ${manifestRel}`);
	} else {
		log.info(`${manifestRel} already exists; nothing to create.`);
	}

	if (namespace !== undefined) {
		log.success(`Recorded namespace \`${namespace}\` in .wonderpressrc`);
	} else if (data.namespaceSource === 'rc') {
		log.info(`Namespace \`${data.namespace}\` (from .wonderpressrc)`);
	} else if (data.namespaceSource === 'blocks') {
		log.info(`Namespace \`${data.namespace}\` (from this theme's existing blocks; not yet recorded in .wonderpressrc)`);
	} else {
		log.warn('No namespace recorded. Blocks will be namespaced after the theme until one is (--namespace <ns> to record one).');
	}

	if (data.legacyPartials) {
		log.info(`${data.legacyPartials} partial director${data.legacyPartials === 1 ? 'y' : 'ies'} under partials/ left as ${data.legacyPartials === 1 ? 'it is' : 'they are'}; nothing was migrated.`);
	}

	return true;
}
