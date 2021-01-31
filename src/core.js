import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const readme = require('./readme');
const wordpress = require('./wordpress');

const open = require('open');
const sh = require('shelljs');

export async function installWonderpressTheme(opts) {
	log.info('Installing Wonderpress Theme...');

	if(!await wordpress.isInstalled()) {
		log.error('WordPress is not installed. Please setup your Wonderpress Development Environment first.');
		return false;
	}

	let url = 'https://github.com/wndrfl/wonderpress-theme/archive/master.zip';
	await wordpress.installTheme(url, opts);
	sh.exec('npm install --prefix ' + wordpress.pathToThemesDir + '/wonderpress-theme');
	return true;
}

export async function installWonderpressDevelopmentEnvironment() {
	log.info('Installing Wonderpress Development Environment...');
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

	await readme.createReadme();

	log.success('All done.');

	return true;
}

export async function startServer() {
	log.info('Starting development server...');
	sh.exec('wp server');
}
