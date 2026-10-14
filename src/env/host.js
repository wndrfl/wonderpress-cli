import sh from 'shelljs';
import { execSync, spawn } from 'child_process';
import * as doctor from '../doctor.js';
import * as log from '../log.js';
import { buildWpCliCommand, toResult } from './command.js';
import { isPortListening, urlTarget } from './probe.js';

// How long a JSON-mode start waits for `wp server` to accept connections
// before giving up on it.
const READY_TIMEOUT_MS = 15000;

/**
 * The host environment backend.
 *
 * WordPress core unpacked into the project directory, a MySQL server the
 * developer runs themselves, WP-CLI on the PATH, and `wp server` — WP-CLI's
 * wrapper around PHP's built-in web server — for serving.
 *
 * This is the behavior WonderPress has always had. Every command below is the
 * one that used to sit inline in core.js, wordpress.js or server.js, moved
 * behind the backend interface without changing what it runs.
 **/
export function create() {

	return {

		name: 'host',

		/**
		 * Where the site will be, once `wonderpress server` is running.
		 *
		 * The host backend honors the hostname it was given, so this is the
		 * --wp-url as supplied, with a scheme if it lacked one.
		 **/
		siteUrl(initConfig) {
			const url = (initConfig && initConfig.wp && initConfig.wp.url) || 'localhost:8080';
			return /^https?:\/\//.test(url) ? url : `http://${url}`;
		},

		/**
		 * How to log in.
		 *
		 * The host backend prompts for these during install, so the password is
		 * the user's own — theirs to remember, and not ours to echo back into a
		 * scrollback buffer.
		 **/
		adminLogin(initConfig) {
			const wp = (initConfig && initConfig.wp) || {};
			return { user: wp.adminUser || 'admin', password: null, note: 'the password you set during install' };
		},

		capabilities: {
			// --db-host / --db-user / --db-password / --db-name are meaningful.
			honorsDbFlags: true,
			// --wp-url's hostname is honored as given.
			honorsSiteHostname: true,
			// `wp server` blocks until Ctrl-C, so start() never returns.
			detachedServer: false,
			// `wp core install --admin_user` names the first user, as asked.
			honorsAdminUser: true,
		},

		/**
		 * WP-CLI does everything here, so its absence is fatal before we write
		 * anything to disk. The check itself is doctor's; see src/doctor.js.
		 **/
		async preflight() {
			return doctor.preflight('host');
		},

		/**
		 * Nothing to set up: the host environment needs no config file of its
		 * own before provisioning can start.
		 **/
		async prepare() {
			return { ok: true, errors: [] };
		},

		/**
		 * Download core, create the database and wp-config.php, then install.
		 *
		 * The backend owns the *order*, not just the individual commands —
		 * a container-based backend provisions along a different graph.
		 **/
		async provision(initConfig) {

			// Imported lazily on purpose: wordpress.js reaches back into this
			// module through the backend registry, so a static import here
			// would close the cycle.
			const wordpress = await import('../wordpress.js');

			await wordpress.downloadWordPress();

			// `=== false` rather than falsy: both of these return undefined on
			// their "already done, nothing to do" early exits, which is success.
			const configured = await wordpress.configureWordPress(initConfig);
			if (configured === false) {
				return { ok: false, errors: ['WordPress could not be configured.'] };
			}

			const installed = await wordpress.installWordPress(initConfig);
			if (installed === false) {
				return { ok: false, errors: ['WordPress could not be installed.'] };
			}

			return { ok: true, errors: [] };
		},

		/**
		 * Run a WP-CLI command. `cmd` omits the leading `wp`.
		 **/
		wpCli(cmd, opts) {
			const command = buildWpCliCommand(['wp'], cmd);
			return toResult(opts ? sh.exec(command, opts) : sh.exec(command));
		},

		/**
		 * Serve with `wp server`. Blocks until Ctrl-C — it does not return.
		 *
		 * With `opts.onReady` (how `server start --format json` calls it) the
		 * child's output goes to stderr instead of inheriting stdout, and
		 * onReady({ pid }) fires once the port accepts connections — so the JSON
		 * envelope is printed, alone, before the long wait for Ctrl-C begins. If
		 * the server dies before it is ready, the result says so instead.
		 **/
		async start(opts = {}) {

			if (typeof opts.onReady === 'function') {
				return startObserved(this.siteUrl(), opts.onReady);
			}

			log.info('Starting development server...');

			execSync('wp server', {
				stdio: [0, 1, 2], // we need this so node will print the command output
			});

			return { url: null, detached: false };
		},

		/**
		 * Is `wp server` up? It runs in someone else's foreground, so the only
		 * way to know from here is to try connecting to where it would listen.
		 * The pid is not knowable from another process without `lsof`, which is
		 * exactly what this avoids.
		 **/
		async status() {
			const url = this.siteUrl();
			const target = urlTarget(url);
			return {
				url,
				port: target ? target.port : null,
				running: target ? await isPortListening(target.port, target.host) : null,
				pid: null,
			};
		},

		/**
		 * There is no daemon to stop; the server is whatever is in the
		 * foreground. Say so rather than erroring — `server stop` should be a
		 * safe thing to type under either backend.
		 **/
		async stop() {
			log.info('The host development server runs in the foreground — stop it with Ctrl-C.');
			return true;
		},

		/**
		 * Drop the database. The files are the caller's to remove.
		 *
		 * The host backend owns nothing outside MySQL — no containers, no
		 * volumes — so this is the whole of its teardown. It is also the only
		 * part a `rm -rf` would leave behind.
		 **/
		async destroy() {
			log.info('Dropping the database...');

			const result = sh.exec('wp db drop --yes', { silent: true });

			if (result.code !== 0) {
				// A database that was never created, or already dropped, is the
				// state we wanted anyway.
				log.warn(`The database could not be dropped — it may already be gone.\n${(result.stderr || '').trim()}`);
			}

			return { ok: true, errors: [] };
		},
	};
}

/**
 * `wp server` as a child we can watch, for JSON mode.
 *
 * stdout of the child is wired to OUR stderr (fd 2): the JSON envelope must be
 * the only thing on stdout. The terminal stays attached otherwise, so Ctrl-C
 * still reaches the child the way it does in human mode.
 **/
async function startObserved(url, onReady) {

	const target = urlTarget(url) || { host: 'localhost', port: 8080 };

	// Readiness is "the port answers", so a port that already answers would
	// make a server that is about to fail look ready. Refuse up front.
	if (await isPortListening(target.port, target.host)) {
		return { ok: false, running: null, url, detached: false, pid: null, errors: [`Something is already listening on port ${target.port}. Is the server already running? Check with: wonderpress server status`] };
	}

	return new Promise((resolve) => {

		// `shell` on Windows only, where `wp` is a .bat shim spawn cannot run
		// directly. The host backend is unsupported there, but failing with a
		// clear message beats ENOENT.
		const child = spawn('wp', ['server'], {
			stdio: ['inherit', 2, 2],
			shell: process.platform === 'win32',
		});

		let ready = false;
		let exited = false;

		child.once('error', (error) => {
			exited = true;
			resolve({ ok: false, url, detached: false, pid: null, errors: [`Could not start wp server: ${error.message}`] });
		});

		child.once('exit', (code, signal) => {
			exited = true;
			if (!ready) {
				resolve({ ok: false, url, detached: false, pid: child.pid ?? null, errors: [`wp server exited before it was ready (${signal || `code ${code}`}).`] });
				return;
			}
			resolve({ ok: true, url, detached: false, pid: child.pid ?? null, exitCode: code, signal });
		});

		const deadline = Date.now() + READY_TIMEOUT_MS;
		const poll = async () => {
			if (exited) {
				return;
			}
			if (await isPortListening(target.port, target.host, 250)) {
				ready = true;
				onReady({ url, port: target.port, pid: child.pid ?? null });
				return;
			}
			if (Date.now() > deadline) {
				child.kill();
				return;
			}
			setTimeout(poll, 200);
		};
		poll();
	});
}
