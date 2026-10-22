import path from 'path';
import sh from 'shelljs';
import * as composer from './composer.js';
import * as config from './config.js';
import * as core from './core.js';
import * as doctor from './doctor.js';
import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import * as wordpress from './wordpress.js';
import { runAsync } from './proc.js';

/**
 * `wonderpress core` — the wonderpress-core dependency, seen and moved from
 * the CLI.
 *
 * Core is a Composer dependency of the theme (ARCHITECTURE.md,
 * "wonderpress-core is a dependency of the theme"), and `composer update`
 * in the theme directory has always been the upgrade lever. Two things made a
 * command worth having on top of that:
 *
 * - `init` records the resolved core version in .wonderpressrc, read back out
 *   of composer.lock, and nothing else ever rewrote it. A bare
 *   `composer update` bumped the lock and left the record claiming the old
 *   version. The CLI owned a record it could not keep true unless it also
 *   owned the update.
 * - The desktop app has no source for the installed core version and no
 *   button for upgrading it. Every mutation it exposes goes through a CLI
 *   command with a JSON envelope; core should not be the exception that
 *   shells out to Composer on its own.
 *
 * The command wraps Composer. It pins nothing: the constraint stays in the
 * theme's composer.json and the CLI still does not restate it (see
 * `core.CORE_PACKAGE`).
 *
 *   wonderpress core status            constraint, lock, vendor, record
 *   wonderpress core update            composer update <package>, re-record
 *   wonderpress core update ^3.0       composer require <package>:^3.0, re-record
 **/

export async function command(subcommand, args) {
	switch (subcommand) {
		case undefined:
		case 'status':
			await status(args);
			break;
		case 'update':
			await update(args);
			break;
		default:
			if (subcommand !== 'help') {
				log.error(`Unknown core subcommand: ${subcommand}`);
				format.fail({
					code: 'unknown_command',
					message: `Unknown core subcommand: ${subcommand}`,
					hint: 'Run `wonderpress core help`.',
				});
			}
			help.show('core');
			break;
	}

	return true;
}

// --- what is on disk --------------------------------------------------------

/**
 * Everything knowable about core in one theme, from the disk alone.
 *
 * No network and no Composer invocation: this is what `status` prints and
 * what `update` compares before and after, so it has to be cheap and it has to
 * work on a machine without Composer.
 *
 *   constraint  what the theme's composer.json asks for
 *   locked      what composer.lock resolved
 *   installed   what vendor/ actually holds (vendor/composer/installed.json)
 *   recorded    what .wonderpressrc claims (`core`)
 *
 * `inSync` is the one-word answer: every non-null value agrees. A null is not a
 * disagreement by itself (a theme with no vendor/ yet has nothing to disagree
 * with), but the human output names each null so nobody mistakes "nothing
 * recorded" for "up to date".
 *
 * @param {String} root The environment root (where .wonderpressrc lives).
 * @param {String} themeDir The theme directory, relative to root or absolute.
 * @returns {Object}
 **/
export function inspect(root, themeDir) {
	const name = core.CORE_PACKAGE;
	const constraint = composer.declaredConstraint(themeDir, name);
	const locked = composer.lockedVersion(themeDir, name);
	const installed = composer.installedVersion(themeDir, name);
	const rc = config.read(root).data;
	const recorded = typeof rc.core === 'string' && rc.core ? rc.core : null;

	const versions = [locked, installed, recorded].filter((v) => v !== null);
	const inSync = versions.every((v) => v === versions[0]);

	return { package: name, constraint, locked, installed, recorded, inSync };
}

/**
 * Which theme `core` operates on.
 *
 * Only themes whose composer.json requires the package are candidates: a
 * theme without it has no core to show or update, and offering it would only
 * produce a Composer error about an unknown package. One candidate needs no
 * flag; several need --theme, and the error names them. --theme naming a theme
 * that exists but does not declare core is its own error, because the fix
 * (add the dependency) is different from the fix for a typo.
 *
 * -> { name, dir } | { error }
 **/
export function pickTheme(args) {
	const themes = wordpress.themesOnDisk();
	const declaring = themes.filter((name) => composer.declaredConstraint(path.join(wordpress.pathToThemesDir, name), core.CORE_PACKAGE));
	const requested = args['--theme'];

	const found = (name) => ({ name, dir: path.join(wordpress.pathToThemesDir, name) });

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
		if (!declaring.includes(requested)) {
			return {
				error: {
					code: 'core_not_declared',
					message: `Theme "${requested}" does not require ${core.CORE_PACKAGE} in its composer.json`,
					hint: `Add it to the theme's composer.json "require" block, then run \`composer install\` there.`,
				},
			};
		}
		return found(requested);
	}

	if (declaring.length === 1) {
		return found(declaring[0]);
	}

	if (declaring.length === 0) {
		return {
			error: {
				code: 'no_core',
				message: `No theme in ${wordpress.pathToThemesDir} requires ${core.CORE_PACKAGE}`,
				hint: themes.length
					? `Themes on disk: ${themes.join(', ')}. None has it in composer.json "require".`
					: 'No theme with a style.css was found.',
			},
		};
	}

	return {
		error: {
			code: 'ambiguous_theme',
			message: `Several themes require ${core.CORE_PACKAGE}; pass --theme <name>`,
			hint: `Themes with core: ${declaring.join(', ')}.`,
		},
	};
}

/**
 * The preamble `status` and `update` share: land in the environment root and
 * settle which theme. -> { root, theme, themeDir } | false (already failed).
 **/
async function locate(args) {
	process.chdir(args['--dir'] ? args['--dir'] : '.');

	if (! await core.setCwdToEnvironmentRoot()) {
		return format.fail({
			code: 'env',
			message: 'This does not appear to be a Wonderpress Development Environment',
			hint: 'Run from inside a project, or pass --dir <root>.',
		});
	}

	const picked = pickTheme(args);
	if (picked.error) {
		log.error(`${picked.error.message}. ${picked.error.hint}`);
		return format.fail(picked.error);
	}

	return { root: process.cwd(), theme: picked.name, themeDir: picked.dir };
}

function describe(value, missing) {
	return value === null ? missing : value;
}

/**
 * The human form of inspect(): one row per source, then the verdict.
 **/
function printState(theme, state) {
	log.card([
		['package', state.package],
		['theme', theme],
		['constraint', describe(state.constraint, '(none in composer.json)')],
		['lock', describe(state.locked, '(not in composer.lock)')],
		['vendor', describe(state.installed, '(not installed)')],
		['recorded', describe(state.recorded, '(nothing in .wonderpressrc)')],
	]);
}

// --- core status ------------------------------------------------------------

/**
 * `wonderpress core status [--theme <name>] [--format json]`.
 *
 * Reads; never runs Composer and never touches the network. The headline is
 * any disagreement between the lock, vendor/ and the record, because that is
 * the state nothing else reports and the one `update` exists to fix.
 **/
export async function status(args) {
	const where = await locate(args);
	if (!where) {
		return false;
	}

	const state = inspect(where.root, where.themeDir);
	const data = { theme: where.theme, ...state };

	if (format.isJson()) {
		return format.ok(data);
	}

	printState(where.theme, state);

	if (!state.locked) {
		log.warn(`composer.lock does not resolve ${state.package}. Run \`composer install\` in ${where.themeDir}, or \`wonderpress core update\`.`);
	} else if (state.inSync) {
		log.success(`Everything agrees on ${state.locked}.`);
	} else {
		if (state.installed && state.installed !== state.locked) {
			log.warn(`vendor/ holds ${state.installed} but composer.lock resolves ${state.locked}. Run \`composer install\` in ${where.themeDir}.`);
		}
		if (state.recorded !== state.locked) {
			log.warn(`.wonderpressrc records ${describe(state.recorded, 'nothing')} but composer.lock resolves ${state.locked}. Run \`wonderpress core update\` to bring both current.`);
		}
	}

	return true;
}

// --- core update ------------------------------------------------------------

/**
 * `wonderpress core update [<constraint>] [--theme <name>] [--dry-run]
 * [--format json]`.
 *
 * Without a constraint: `composer update <package>` in the theme. Composer
 * resolves fresh inside the constraint the theme already declares, which is
 * what a caret range means for a minor bump and why a major needs the
 * argument.
 *
 * With one: `composer require <package>:<constraint>`, which rewrites
 * composer.json, re-resolves and installs in one step. The CLI does not edit
 * composer.json itself for the same reason init does not (core.js,
 * applyCoreOverride): Composer validates the result and writes the lock that
 * goes with it.
 *
 * Either way the version the lock ends up with is recorded in .wonderpressrc,
 * so the record `init` wrote stays true. A run that changes nothing still
 * re-records, which is how a record that drifted gets repaired.
 *
 * WONDERPRESS_CORE_REPO / WONDERPRESS_CORE_REF warn exactly as they do during
 * init and nothing more: a project built from an override already carries the
 * repository and constraint in its composer.json, and Composer resolves
 * against those. The override is not re-applied here.
 **/
export async function update(args) {
	const where = await locate(args);
	if (!where) {
		return false;
	}

	const constraint = args._ && args._[2];
	if (constraint !== undefined && (typeof constraint !== 'string' || !constraint || constraint.startsWith('-'))) {
		log.error(`"${constraint}" is not a version constraint. Example: wonderpress core update ^3.0`);
		return format.fail({
			code: 'usage',
			message: `"${constraint}" is not a version constraint`,
			hint: 'wonderpress core update [<constraint>], e.g. ^3.0',
		}, format.EXIT_USAGE);
	}

	if (!sh.which('composer')) {
		log.error(doctor.HINTS.composer);
		return format.fail({
			code: 'composer_missing',
			message: 'Composer is not installed, or is not on your PATH',
			hint: doctor.HINTS.composer,
		});
	}

	// Warn-only: see the docblock.
	core.resolveCoreOverride();

	const dryRun = args['--dry-run'] === true;
	const before = inspect(where.root, where.themeDir);

	const argv = constraint
		? ['require', `${core.CORE_PACKAGE}:${constraint}`, '--no-interaction']
		: ['update', core.CORE_PACKAGE, '--no-interaction'];
	if (dryRun) {
		argv.push('--dry-run');
	}

	log.info(`Running composer ${argv.join(' ')} in ${where.themeDir}...`);

	// Async so the desktop app can cancel it the way it cancels init (proc.js).
	const result = await runAsync('composer', argv, { cwd: where.themeDir });

	if (result.code !== 0) {
		log.error(`Composer failed in ${where.themeDir} (exit ${result.code}). Nothing was recorded.`);
		return format.fail({
			code: 'composer',
			message: `composer ${argv[0]} failed in ${where.themeDir}`,
			hint: 'Composer\'s own output above says why. The lock file and .wonderpressrc were left as they were.',
		}, format.EXIT_FAIL, { theme: where.theme, before, command: ['composer', ...argv] });
	}

	const after = inspect(where.root, where.themeDir);
	const changed = after.locked !== before.locked;

	let recorded = false;
	if (!dryRun && after.locked) {
		recorded = config.write(where.root, { core: after.locked });
		if (recorded) {
			after.recorded = after.locked;
			after.inSync = [after.locked, after.installed, after.recorded].filter((v) => v !== null).every((v) => v === after.locked);
		}
	}

	const data = {
		theme: where.theme,
		package: core.CORE_PACKAGE,
		command: ['composer', ...argv],
		dryRun,
		changed,
		recorded,
		before,
		after,
	};

	if (format.isJson()) {
		return format.ok(data);
	}

	if (dryRun) {
		log.info(`Dry run: nothing was changed or recorded.`);
		return true;
	}

	if (!after.locked) {
		log.warn(`Composer finished, but composer.lock does not resolve ${core.CORE_PACKAGE}. Nothing was recorded.`);
		return true;
	}

	if (changed) {
		log.success(`${core.CORE_PACKAGE} ${describe(before.locked, '(none)')} → ${after.locked} in ${where.theme}`);
	} else {
		log.info(`${core.CORE_PACKAGE} is already at ${after.locked} in ${where.theme}; nothing to update.`);
	}

	if (constraint && after.constraint !== before.constraint) {
		log.info(`Constraint ${describe(before.constraint, '(none)')} → ${after.constraint} in composer.json`);
	}

	if (recorded) {
		log.success(`Recorded ${after.locked} in .wonderpressrc`);
	}

	if (after.installed && after.installed !== after.locked) {
		log.warn(`vendor/ holds ${after.installed} but composer.lock resolves ${after.locked}. Run \`composer install\` in ${where.themeDir}.`);
	}

	log.info(`Commit composer.json, composer.lock, vendor/ and .wonderpressrc together — the theme ships its vendor/.`);

	return true;
}
