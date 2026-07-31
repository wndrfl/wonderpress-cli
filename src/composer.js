import fs from 'fs-extra';
import sh from 'shelljs';
import * as log from './log.js';

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
