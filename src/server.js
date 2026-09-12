import * as log from './log.js';
import * as core from './core.js';
import * as env from './env/index.js';

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
 * Start the development server for whichever backend this environment uses.
 *
 * How that happens is the backend's business: the host blocks in the
 * foreground until Ctrl-C, where a container-based backend brings the
 * environment up and returns.
 **/
export async function start(dir) {

	dir = dir || process.cwd();
	process.chdir(dir);

	// The server command needs to be run from root
	// Try and force cwd context to root
	if (! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	const result = await env.getCurrent().start();

	// A detached backend has returned with the site still up, so say where it
	// is. A foreground one never reaches this line.
	if (result && result.detached && result.url) {
		log.success(`The development environment is running at ${result.url}`);
	}

	return true;
}
