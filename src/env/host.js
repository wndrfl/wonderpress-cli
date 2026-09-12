import sh from 'shelljs';
import { execSync } from 'child_process';
import * as log from '../log.js';
import { buildWpCliCommand, toResult } from './command.js';

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

		capabilities: {
			// --db-host / --db-user / --db-password / --db-name are meaningful.
			honorsDbFlags: true,
			// --wp-url's hostname is honored as given.
			honorsSiteHostname: true,
			// `wp server` blocks until Ctrl-C, so start() never returns.
			detachedServer: false,
		},

		/**
		 * WP-CLI does everything here, so its absence is fatal before we write
		 * anything to disk.
		 **/
		async preflight() {

			if (!sh.which('wp')) {
				return {
					ok: false,
					errors: [`Wonderpress leans heavily on the WP CLI. Please visit https://wp-cli.org/ and follow installation instructions before trying again.`],
				};
			}

			return { ok: true, errors: [] };
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
		 **/
		async start() {

			log.info('Starting development server...');

			execSync('wp server', {
				stdio: [0, 1, 2], // we need this so node will print the command output
			});

			return { url: null, detached: false };
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
	};
}
