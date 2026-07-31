import sh from 'shelljs';
import * as log from './log.js';
import { execSync } from 'child_process';
import * as core from './core.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch (subcommand) {
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
	if (! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	log.info('Starting development server...');

	execSync('wp server', {
		stdio: [0, 1, 2], // we need this so node will print the command output
	});
}
