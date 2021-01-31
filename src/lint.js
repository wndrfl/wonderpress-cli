import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const sh = require('shelljs');
const wordpress = require('./wordpress');

export async function lintTheme(name, fix) {

	log.info('Attempting to lint the active theme...');

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

	if(!name) {
		let theme = await wordpress.getActiveTheme();

		// If there is no active theme, we need to stop.
		// The linter will only lint an active theme.
		if(!theme) {
			log.error('There is no active theme. Please fully install WordPress and activate a theme before trying again.');
			return false;
		}

		name = theme.name;
	}

	let path = wordpress.pathToThemesDir + '/' + name;

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
		this.lintTheme(name, false);

	}else{
		log.error('Issues were found during lint! Please see above...');
	} 

	if(fix === null) {
		log.info('If you would like Wonderpress to automatically fix as many issues as possible, add the --fix (or -f) flag to the command.');
	}

	return true;
}