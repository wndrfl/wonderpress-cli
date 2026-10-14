import * as log from './log.js';
import * as core from './core.js';
import * as env from './env/index.js';
import * as format from './format.js';
import { isPortListening, urlTarget } from './env/probe.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch (subcommand) {
		case 'stop':
			await stop(args['--dir'] || null);
			break;
		case 'status':
			await status(args['--dir'] || null);
			break;
		// `wonderpress server` with no subcommand has always meant start, and
		// people type it that way.
		case undefined:
		case 'start':
			await start(args['--dir'] || null);
			break;
		default:
			// This used to fall through to start, so `server stauts` brought an
			// environment up. A typo should not have side effects.
			log.error(`Unknown server subcommand: ${subcommand} (expected start, stop or status)`);
			return format.fail({
				code: 'unknown_command',
				message: `Unknown server subcommand: ${subcommand}`,
				hint: 'Run `wonderpress server help`.',
			});
	}

	return true;
}

/**
 * The `data` every `server --format json` envelope carries.
 *
 * `url`, `adminUrl` and `port` are where the site is served (or would be) —
 * they are reported whether or not it is running, so a supervisor can show
 * the address next to a stopped server. `running` is the live answer: true,
 * false, or null when there was nothing to ask. `pid` is only known to the
 * process that spawned the server (host start in JSON mode); everywhere else
 * it is null.
 **/
export function describe(backend, { running = null, url = null, port = null, pid = null } = {}) {
	const target = port ? null : urlTarget(url);
	return {
		backend: backend.name,
		detached: !!(backend.capabilities && backend.capabilities.detachedServer),
		running,
		url: url || null,
		adminUrl: url ? `${url.replace(/\/+$/, '')}/wp-admin` : null,
		port: port || (target ? target.port : null),
		pid: pid ?? null,
	};
}

function siteUrlOf(backend) {
	return typeof backend.siteUrl === 'function' ? backend.siteUrl() : null;
}

/**
 * Find the root and chdir to it, or fail with an envelope. Every subcommand
 * starts here: they all have to run against the environment's own backend.
 **/
async function enterRoot(dir) {

	process.chdir(dir || process.cwd());

	// The server command needs to be run from root
	// Try and force cwd context to root
	if (await core.setCwdToEnvironmentRoot()) {
		return true;
	}

	format.fail({
		code: 'environment',
		message: 'This does not appear to be a Wonderpress Development Environment.',
		hint: 'Run from inside a project, or pass --dir <project root>.',
	});
	return false;
}

/**
 * Ask the backend whether its server is up. A backend without status() (an
 * older fake, a future backend) is probed at its site URL.
 **/
export async function probe(backend) {

	if (typeof backend.status === 'function') {
		return await backend.status();
	}

	const url = siteUrlOf(backend);
	const target = urlTarget(url);
	return {
		url,
		port: target ? target.port : null,
		running: target ? await isPortListening(target.port, target.host) : null,
		pid: null,
	};
}

/**
 * Start the development server for whichever backend this environment uses.
 *
 * How that happens is the backend's business: the host blocks in the
 * foreground until Ctrl-C, where a container-based backend brings the
 * environment up and returns.
 *
 * In JSON mode the envelope is printed once the site answers. For a detached
 * backend that is after start() returns. For the host, start() never returns
 * while the server lives, so it is handed an onReady callback, prints the
 * envelope from there, and keeps running with `wp server`'s own output
 * diverted to stderr. One line of JSON on stdout either way.
 **/
export async function start(dir) {

	if (! await enterRoot(dir)) {
		return false;
	}

	const backend = env.getCurrent();
	const detached = !!(backend.capabilities && backend.capabilities.detachedServer);
	const url = siteUrlOf(backend);

	if (format.isJson()) {
		return startJson(backend, detached, url);
	}

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

async function startJson(backend, detached, url) {

	let announced = false;

	const result = await backend.start({
		onReady: ({ url: readyUrl, port, pid } = {}) => {
			announced = true;
			format.ok(describe(backend, { running: true, url: readyUrl || url, port, pid }));
		},
	});

	if (announced) {
		// The foreground server has since exited (Ctrl-C, or the supervisor
		// killed it). The envelope already went out; nothing more on stdout.
		return true;
	}

	if (!result || result.ok === false) {
		const errors = (result && result.errors) || [];
		return format.fail({
			code: 'server',
			message: errors[0] || 'The development server could not be started.',
			hint: 'Run `wonderpress doctor` to check prerequisites.',
		}, format.EXIT_FAIL, describe(backend, {
			// A backend may know better than "not running" — the host refuses to
			// start over a port something already answers on, which is unknown.
			running: result && result.running !== undefined ? result.running : false,
			url: (result && result.url) || url,
			pid: result && result.pid,
		}));
	}

	return format.ok(describe(backend, {
		// A detached backend that returned without error is up. A foreground
		// one that returned without calling onReady was a backend that does not
		// know about onReady; the honest answer is "unknown".
		running: detached ? true : null,
		url: result.url || url,
		pid: result.pid,
	}));
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

	if (! await enterRoot(dir)) {
		return false;
	}

	const backend = env.getCurrent();
	const stopped = await backend.stop();

	if (!format.isJson()) {
		return stopped;
	}

	const detached = !!(backend.capabilities && backend.capabilities.detachedServer);

	if (stopped === false) {
		return format.fail({
			code: 'server',
			message: 'The development environment could not be stopped.',
			hint: null,
		}, format.EXIT_FAIL, describe(backend, { running: null, url: siteUrlOf(backend) }));
	}

	if (!detached) {
		// log.* is silent in JSON mode, and this is worth saying.
		process.stderr.write('The host development server runs in the foreground; stop it with Ctrl-C, or signal the process that started it.\n');
	}

	// A detached backend that stopped cleanly is down. The host has nothing
	// this process can stop — its server is someone's foreground job — so
	// report what is actually true rather than claiming it stopped.
	const after = detached ? { running: false, url: siteUrlOf(backend) } : await probe(backend);

	return format.ok(describe(backend, after));
}

/**
 * Is the server up?
 *
 * Works the same from any process: wp-env is asked directly, the host is
 * probed by connecting to its port. A query, so it exits 0 either way; the
 * answer is in `running`.
 **/
export async function status(dir) {

	if (! await enterRoot(dir)) {
		return false;
	}

	const backend = env.getCurrent();
	const data = describe(backend, await probe(backend));

	if (format.isJson()) {
		return format.ok(data);
	}

	if (data.running) {
		log.success(`The ${data.backend} server is running.`);
		reportUrls(data.url);
	} else if (data.running === false) {
		log.info(`The ${data.backend} server is not running${data.url ? ` (it serves ${data.url})` : ''}. Start it with: wonderpress server`);
	} else if (data.port) {
		// wp-env could not answer, and something holds the port anyway. It may
		// be this environment; it is as likely another project's.
		log.warn(`Could not tell whether the ${data.backend} server is running: something is listening on port ${data.port}, but nothing confirmed it is this project's.`);
	} else {
		log.warn(`Could not tell whether the ${data.backend} server is running.`);
	}

	return true;
}
