import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const sh = require('shelljs');
const wordpress = require('./wordpress');

export async function lintTheme(name) {

	await composer.installComposer();

	await wordpress.createThemesDirectory();

	if(!name) {
		let theme = await wordpress.getActiveTheme();
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