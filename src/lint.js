import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const sh = require('shelljs');
const wordpress = require('./wordpress');

export async function lintTheme(name) {

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
	sh.exec(cmd);

	let fixAnswer = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'confirm',
			message: 'Would you like to automatically fix as many of these as possible?',
			default: false
		}
	]);
	
	if(fixAnswer.confirm) {
		let fixCmd = './vendor/bin/phpcbf';
		fixCmd 		+= ' ' + path;
		fixCmd		+= ' -p -v --colors';
		sh.exec(fixCmd);
	}

	return true;
}