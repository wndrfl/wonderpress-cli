const { execSync } = require('child_process');
const core = require('./core');
const log = require('./log');

export async function command(subcommand, args) {
	switch(subcommand) {
		case 'start':
			await start(args);
			break;
	}

	return true;
}

export async function start(args) {

	const dir = args['--dir'] ? args['--dir'] : '.';
	process.chdir(dir);

	if(! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	log.info('Starting development server...');
	
	execSync('wp server', {
	  stdio: [0, 1, 2], // we need this so node will print the command output
	});
}