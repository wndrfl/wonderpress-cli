const { execSync } = require('child_process');
const core = require('./core');
const log = require('./log');

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch(subcommand) {
		case 'start':
			await start(args['--dir'] || null);
			break;
	}

	return true;
}

/**
 * Start a server with `wp server`.
 **/
export async function start(dir) {

	dir = dir || process.cwd();
	process.chdir(dir);

  // The server command needs to be run from root
  // Try and force cwd context to root
	if(! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	log.info('Starting development server...');
	
	execSync('wp server', {
	  stdio: [0, 1, 2], // we need this so node will print the command output
	});
}
