const composer = require('./composer');
const core = require('./core');
const inquirer = require('inquirer');
const log = require('./log');
const sh = require('shelljs');
const wordpress = require('./wordpress');

export async function command(subcommand, args) {
	switch(subcommand) {
		case 'theme':
			await theme(args);
			break;
	}

	return true;
}

export async function theme(args) {

	log.info('Attempting to lint the active theme...');

	const dir = args['--dir'] ? args['--dir'] : '.';
	process.chdir(dir);

	if(! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	if(! await core.isWonderpressRoot()) {
		log.error('Please run the lint command from the root directory of this project.');
		return false;
	}

	if(! await wordpress.isInstalled()) {
		log.error('WordPress is not installed. Please install WordPress first.');
		return false;
	}

	if(! await composer.installComposer()) {
		return;
	}

	if(! await wordpress.createThemesDirectory()) {
		return;
	}

	const fix = args['--fix'] ? args['--fix'] : false;
	let themeName = args['--name'] ? args['--name'] : null;

	if(!themeName) {
		let theme = await wordpress.getActiveTheme();

		// If there is no active theme, we need to stop.
		// The linter will only lint an active theme.
		if(!theme) {
			log.error('There is no active theme. Please fully install WordPress and activate a theme before trying again.');
			return false;
		}

		themeName = theme.name;
	}

	let path = wordpress.pathToThemesDir + '/' + themeName;

	let cmd = './vendor/bin/phpcs';
	cmd		+= ' ' + path;
	cmd		+= ' -p -v --colors';
	let lintResult = await sh.exec(cmd);

	// lintResult.code will be 1 if there are any
	// issues found in the lint.
	if(lintResult.code === 0) {
		log.success('Great! The theme passed all lints.');
		return true;
	}

	if(fix) {
		let fixCmd = './vendor/bin/phpcbf';
		fixCmd 		+= ' ' + path;
		fixCmd		+= ' -p -v --colors';
		sh.exec(fixCmd);

		log.info('All issues that could be fixed were fixed. Rerunning lint...');
		theme(themeName, false);

	}else{
		log.error('Issues were found during lint! Please see above...');
	} 

	if(!fix) {
		log.info('If you would like Wonderpress to automatically fix as many issues as possible, add the --fix (or -f) flag to the command.');
	}

	return true;
}
