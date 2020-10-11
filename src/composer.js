const fs = require('fs');
const log = require('./log');
const sh = require('shelljs');

export async function installComposer() {
	if (await !fs.existsSync('./vendor')) {
		log.info('Installing Composer packages...');
		sh.exec('composer install');
	}

	return true;
}