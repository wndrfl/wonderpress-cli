import fs from 'fs-extra';
import sh from 'shelljs';
import * as log from './log.js';
import * as composer from './composer.js';
import * as core from './core.js';
import inquirer from 'inquirer';
import * as wordpress from './wordpress.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch (subcommand) {
		case 'theme':
			await theme(args['--dir'] || null, {
				fix: args['--fix'] || false,
				name: args['--name'] || null,
			});
			break;
	}

	return true;
}

/**
 * Codesniff a specific theme (or the active theme).
 **/
export async function theme(dir, opts) {

	log.info('Attempting to lint the active theme...');

	opts = opts || {};

	dir = dir || process.cwd();
	process.chdir(dir);

	if (! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	if (! await composer.installComposer()) {
		return;
	}

	const fix = opts.fix ? opts.fix : false;
	let themeName = opts.name ? opts.name : null;

	// phpcs is a static pass over files on disk: it never boots WordPress and
	// never opens a socket. The only thing it needed WordPress for was deciding
	// WHICH theme to lint, so that is the only thing gated now.
	//
	// This used to require a running, database-connected install — two round
	// trips through the backend before any analysis, which under a container
	// backend means the environment has to be up to run a static check.
	if (!themeName) {
		const theme = await wordpress.getActiveTheme({ quiet: true });

		if (theme) {
			themeName = theme.name;
		} else {
			// Nothing running to ask. One theme on disk is not ambiguous, so
			// lint it and say so rather than refusing.
			const candidates = wordpress.themesOnDisk();

			if (candidates.length === 1) {
				themeName = candidates[0];
				log.info(`Could not ask WordPress which theme is active, so linting the only one present: ${themeName}`);
			} else if (candidates.length === 0) {
				log.error(`No themes found in ${wordpress.pathToThemesDir}.`);
				return false;
			} else {
				log.error(`Cannot tell which theme to lint: WordPress is not answering, and there is more than one theme.\nName one: wonderpress lint --name <theme>`);
				return false;
			}
		}
	}

	let path = wordpress.pathToThemesDir + '/' + themeName;

	let cmd = './vendor/bin/phpcs';
	cmd += ' ' + path;
	cmd += ' -p -v --colors';
	let lintResult = await sh.exec(cmd);

	// lintResult.code will be 1 if there are any
	// issues found in the lint.
	if (lintResult.code === 0) {
		log.success('Great! The theme passed all lints.');
		return true;
	}

	if (fix) {
		let fixCmd = './vendor/bin/phpcbf';
		fixCmd += ' ' + path;
		fixCmd += ' -p -v --colors';
		sh.exec(fixCmd);

		log.info('All issues that could be fixed were fixed. Rerunning lint...');
		theme(process.cwd(), {
			name: themeName
		});

	} else {
		log.error('Issues were found during lint! Please see above...');
	}

	if (!fix) {
		log.info('If you would like Wonderpress to automatically fix as many issues as possible, add the --fix (or -f) flag to the command.');
	}

	return true;
}
