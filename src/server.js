import * as log from './log.js';
import * as core from './core.js';
import * as env from './env/index.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch (subcommand) {
		case 'stop':
			await stop(args['--dir'] || null);
			break;
		// `wonderpress server` with no subcommand has always meant start, and
		// people type it that way.
		case 'start':
		default:
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

	const backend = env.getCurrent();
	const detached = !!(backend.capabilities && backend.capabilities.detachedServer);
	const url = typeof backend.siteUrl === 'function' ? backend.siteUrl() : null;

	// A foreground backend hands the terminal to `wp server` and never returns,
	// so its addresses have to be on screen BEFORE it starts. A detached one
	// prints them afterwards, where they land under the backend's own startup
	// noise instead of being scrolled away by it.
	if (url && !detached) {
		reportUrls(url);
	}

	const result = await backend.start();

	// A detached backend has returned with the site still up, so say where it
	// is. A foreground one never reaches this line.
	if (result && result.detached) {
		const running = result.url || url;
		if (running) {
			reportUrls(running);
		}
	}

	return true;
}

/**
 * Where to point a browser.
 *
 * `server` used to end on one line naming the site and nothing else, which left
 * out wp-admin — the address people actually want the morning after an init.
 * Same card `init` ends on, minus the credentials: nothing at start time knows
 * what was chosen at install, where init still has the config in hand.
 **/
function reportUrls(url) {
	log.card([
		['Site', url],
		['Admin', `${url}/wp-admin`],
	]);
}

/**
 * Stop the development environment.
 *
 * Both backends have always had a stop(), and nothing ever called it — so a
 * wp-env environment could be started by the CLI and only stopped by reaching
 * past it to `wp-env stop`. Backends differ in whether there is anything to do:
 * the host server blocks in the foreground and is stopped with Ctrl-C, where a
 * container backend has to be told.
 *
 * Distinct from `destroy`, and the difference is the data. Stopping frees the
 * port and leaves the database intact; destroying removes it.
 **/
export async function stop(dir) {

	dir = dir || process.cwd();
	process.chdir(dir);

	if (! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	return await env.getCurrent().stop();
}
