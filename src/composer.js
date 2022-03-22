const fs = require('fs');
const log = require('./log');
const sh = require('shelljs');

/**
 * Installs Composer packages
 **/
export async function installComposer() {

	log.info('Checking for an existing Composer installation...');

	if (await !fs.existsSync('./vendor')) {
		log.info('Installing Composer packages...');
		sh.exec('composer update');
	}

	log.info('Composer is installed!');

	return true;
}
