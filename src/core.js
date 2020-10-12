import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const wordpress = require('./wordpress');

const open = require('open');
const sh = require('shelljs');

export async function installWonderpressTheme(opts) {
	let url = 'https://github.com/wndrfl/wonderpress-theme/archive/master.zip';
	await wordpress.installTheme(url, opts);
	sh.exec('npm install --prefix ' + wordpress.pathToThemesDir + '/wonderpress-theme');
	return true;
}

export async function installWonderpressDevelopmentEnvironment() {
	let cmd = 'git clone https://github.com/wndrfl/wonderpress-development-environment.git .tmp --progress --verbose';
	sh.exec(cmd);
	sh.exec('rm -rf .tmp/.git && cp -rp .tmp/ . && rm -rf .tmp');
}

export async function installWPCLI() {
	// Install `wp-cli` latest release
	if (!sh.which('wp')) {
		log.info('Downloading and installing WP CLI');
		sh.exec('curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar');
		sh.exec('mv wp-cli.phar wp-cli');
	}

	return true;
}

export async function setup() {

	log.info('✨ Setting up Wonderpress...');

	await installWPCLI();
	await wordpress.downloadWordPress();
	await installWonderpressDevelopmentEnvironment();
	await wordpress.configureWordPress();
	await wordpress.installWordPress();
	await composer.installComposer();

	await installWonderpressTheme({
		activate: true
	});

	log.success('All done.');

	return true;
}

export async function startServer() {
	log.info('Starting development server...');
	// open('http://localhost:8080');
	sh.exec('wp server');
}
