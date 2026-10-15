import fs from 'fs-extra';
import path from 'path';
import sh from 'shelljs';
import * as doctor from '../doctor.js';
import * as log from '../log.js';
import { run } from '../proc.js';
import { DEFAULT_WP_ENV_PORT, isPortFree, isPortListening, readWpEnvPort } from './probe.js';

// Re-exported: this is where callers and tests have always found it.
export { isPortFree };

/**
 * The wp-env environment backend: WordPress, MariaDB and a pinned PHP running
 * in Docker, with the project bind-mounted into the container.
 *
 * Everything here is shaped by what @wordpress/env actually does, verified
 * against 11.12.0 rather than read from its README:
 *
 * - With `"core": "."` the whole project is mounted at /var/www/html, so the
 *   theme, the mu-plugins, vendor/ and .wonderpress/ are all already in the web
 *   root. No `mappings` are needed.
 * - `wp-env start` reads `wp-includes/version.php` BEFORE it boots any
 *   container, so WordPress core must already be on disk. Host WP-CLI is still
 *   required, and `wp core download` still runs first.
 * - wp-env runs its own `wp core install` with a hard-coded admin/password and
 *   a site title taken from the directory name. Neither is configurable, so the
 *   values the user asked for are applied afterwards.
 * - Without `autoPort`, wp-env does not pre-check the port; a busy one surfaces
 *   as a bare "Error while running docker compose command." So we check first.
 **/

const DEFAULT_PORT = DEFAULT_WP_ENV_PORT;

// The config wp-env reads. Kept here (rather than in the scaffold) while the
// backend is opt-in and hand-driven; it moves into
// wonderpress-development-environment when the ergonomics land.
const DEFAULT_CONFIG = {
	$schema: 'https://schemas.wp.org/trunk/wp-env.json',
	core: '.',
	phpVersion: '8.2',
	// Not a nicety. The default (true) is deprecated, and with a local core it
	// makes wp-env recursively copy the ENTIRE project — vendor/, static/dist,
	// everything — into ~/.wp-env on every config-changing start.
	testsEnvironment: false,
	port: DEFAULT_PORT,
	config: {
		WP_DEBUG: true,
		WP_DEBUG_LOG: true,
		WP_DEBUG_DISPLAY: false,
		SCRIPT_DEBUG: true,
		WP_ENVIRONMENT_TYPE: 'local',
	},
};

/**
 * Locate the wp-env binary: the project's own copy first, then a global one.
 *
 * Project-local first matches upstream's own precedence — `bin/wp-env` already
 * redirects to a project-local install when it finds one, so resolving it
 * directly just makes that explicit.
 **/
export function resolveWpEnvBin(root, platform = process.platform) {

	// npm writes a `.cmd` shim beside the sh one on Windows; the sh one is
	// what exists everywhere, but only the `.cmd` is runnable there.
	const name = platform === 'win32' ? 'wp-env.cmd' : 'wp-env';
	const local = path.join(root || process.cwd(), 'node_modules', '.bin', name);
	if (fs.existsSync(local)) return local;

	const global = sh.which('wp-env');
	if (global) return global.toString();

	return false;
}

/**
 * Build the .wp-env.json contents.
 *
 * Only the port is taken from the caller. The database block is meaningless
 * (wp-env fixes its MySQL at root/password/wordpress) and the site title and
 * admin identity cannot be expressed in this file at any price — they are
 * applied after start instead.
 **/
export function buildWpEnvConfig(opts = {}) {
	return { ...DEFAULT_CONFIG, port: opts.port || DEFAULT_PORT };
}

/**
 * Pull a port out of a --wp-url like `localhost:8080`, if there is one.
 **/
export function portFromUrl(url) {
	const match = /:(\d{2,5})(?:\/|$)/.exec(String(url || ''));
	return match ? Number(match[1]) : null;
}

/**
 * Insert the `--` separator wp-env uses to pass flags through to the inner
 * command, so a `--debug` or `--config` meant for wp is never eaten by
 * wp-env's own option parser.
 **/
export function splitForWpEnv(args) {
	const i = args.findIndex((arg) => String(arg).startsWith('-'));
	if (i === -1) return args;
	return [...args.slice(0, i), '--', ...args.slice(i)];
}

function readPort(root) {
	return readWpEnvPort(root);
}

/**
 * Run a wp-env subcommand as argv (src/proc.js): wp-env hands argv straight
 * to spawn with no inner shell, so there is no quoting to get wrong. On
 * Windows the binary is npm's `wp-env.cmd`, which run() takes through cmd.exe
 * with every argument escaped.
 *
 * wp-env collapses every non-zero exit to 1, so the code carries no more
 * information than "it failed".
 **/
function runWpEnv(bin, args, opts = {}) {

	return run(bin, args, {
		cwd: opts.cwd || process.cwd(),
		// `input` replaces the inherited stdin, which is how wp-env's own
		// confirmation prompt gets answered without a human present. Its
		// stderr is CAPTURED rather than inherited in that case: the message is
		// the only way to tell "already gone" from "could not be removed", and
		// an inherited stream reaches the terminal without reaching us.
		//
		// `silent: false` leaves the wiring to run(): wp-env prints its
		// progress ("Pulling…", "Starting WordPress…") on stdout, and a start
		// can take minutes after a Docker restart. A captured pipe would hold
		// every line until exit, so whoever is watching (a terminal, or the
		// desktop app's console) sees nothing and then everything. run()
		// streams it live: to stdout for a human, to stderr under --format
		// json and MCP so stdout stays a single envelope.
		...(opts.input !== undefined
			? { stdio: ['pipe', 'pipe', 'pipe'] }
			: opts.silent === false
				? {}
				: { stdio: ['ignore', 'pipe', 'pipe'] }),
		input: opts.input,
	});
}

export function create() {

	// Resolved lazily: `init` chdirs into the target directory after the
	// backend is chosen, so the root is not known at construction time.
	const root = () => process.cwd();
	const bin = () => resolveWpEnvBin(root());

	return {

		name: 'wp-env',

		/**
		 * Where the site is, once provisioned.
		 *
		 * Read from the config actually written rather than recomputed from the
		 * caller's flags, so it reports where the site IS and not where it was
		 * asked to be. WP_SITEURL's port is force-replaced by wp-env and
		 * *.localhost does not resolve everywhere, so the answer is always
		 * http://localhost:<port>.
		 **/
		siteUrl() {
			return `http://localhost:${readPort(root())}`;
		},

		/**
		 * How to log in.
		 *
		 * wp-env installs WordPress itself during `wp-env start`, so it — not
		 * Wonderpress — creates the first user, and never prompts for it. The
		 * credentials are wp-env's fixed, documented defaults: admin/password.
		 *
		 * Printing that password is not leaking a secret, it is quoting a
		 * published default the user did not choose and has no way to guess. If
		 * they DID supply one, it stops being ours to repeat.
		 **/
		adminLogin(initConfig) {
			const wp = (initConfig && initConfig.wp) || {};

			return {
				user: 'admin',
				password: wp.adminPassword ? null : 'password',
				note: wp.adminPassword ? null : "wp-env's default",
			};
		},

		capabilities: {
			// wp-env's MySQL is fixed at root/password/wordpress.
			honorsDbFlags: false,
			// WP_SITEURL's port is force-replaced, and *.localhost does not
			// resolve everywhere. The site is http://localhost:<port>, full stop.
			honorsSiteHostname: false,
			// `wp-env start` returns with the site still up.
			detachedServer: true,
			// wp-env creates the first user itself, always called `admin`. A
			// different --admin-user cannot rename it; it would only add a SECOND
			// administrator, leaving the requested account and the working one as
			// different users.
			honorsAdminUser: false,
		},

		/**
		 * Docker, Compose v2, a live daemon, wp-env, and — still — WP-CLI.
		 *
		 * Each failure names `--env host`, because the host backend remaining
		 * available is the whole premise of this being opt-in.
		 **/
		async preflight() {
			// The checks themselves are doctor's (src/doctor.js), so `wonderpress
			// doctor` and a failed init report the same things in the same words.
			return doctor.preflight('wp-env');
		},

		/**
		 * Write .wp-env.json if the project does not already have one. Never
		 * overwrite: it is a reviewable file the project owns.
		 **/
		async prepare(initConfig) {

			const cwd = root();
			const configPath = path.join(cwd, '.wp-env.json');

			if (! fs.existsSync(configPath)) {
				const port = portFromUrl((initConfig && initConfig.wp && initConfig.wp.url)) || DEFAULT_PORT;
				fs.writeFileSync(configPath, JSON.stringify(buildWpEnvConfig({ port }), null, '\t') + '\n');
				log.info(`Wrote .wp-env.json (WordPress in Docker, port ${port}).`);
			}

			// wp-env is the project's own devDependency, so this backend
			// installs it rather than demanding the user do it first. It has to
			// happen here: preflight runs before init changes into the target
			// directory, so there is nothing project-local to find yet.
			if (bin()) {
				return { ok: true, errors: [] };
			}

			if (! fs.existsSync(path.join(cwd, 'package.json'))) {
				return {
					ok: false,
					errors: [`wp-env is not available and this environment has no package.json to install it from.\n  In this project:  npm install --save-dev @wordpress/env\n  Or globally:      npm i -g @wordpress/env\nOr build the host environment instead: wonderpress init`],
				};
			}

			log.info('Installing project tooling (wp-env)...');
			const installed = run('npm', ['install'], { silent: true });

			if (installed.code !== 0) {
				return { ok: false, errors: [`npm install failed at the environment root.\n${installed.stderr}`.trim()] };
			}

			if (! bin()) {
				return { ok: false, errors: [`npm install ran, but wp-env is still not present. Does this project's package.json declare @wordpress/env?`] };
			}

			return { ok: true, errors: [] };
		},

		/**
		 * Core onto disk, then bring the containers up, then apply the values
		 * wp-env's own install could not take.
		 **/
		async provision(initConfig) {

			const wordpress = await import('../wordpress.js');
			const wpEnvBin = bin();
			const cwd = root();
			const port = readPort(cwd);

			// MUST come first: wp-env reads wp-includes/version.php before it
			// boots anything, and dies with ENOENT if core is not there.
			await wordpress.downloadWordPress();

			if (! await isPortFree(port)) {
				return {
					ok: false,
					errors: [doctor.portInUseHint(port)],
				};
			}

			log.info('Starting the Docker environment (this can take a few minutes the first time)...');
			const started = runWpEnv(wpEnvBin, ['start'], { cwd, silent: false });
			if (started.code !== 0) {
				return {
					ok: false,
					errors: [`wp-env could not start the environment.\n${started.stderr || started.stdout}`.trim()],
				};
			}

			this.applyInitConfig(initConfig, { cwd, bin: wpEnvBin });

			log.success(`WordPress is running at http://localhost:${port}`);

			return { ok: true, errors: [] };
		},

		/**
		 * wp-env installs WordPress itself with `--admin_user=admin
		 * --admin_password=password` and the directory name as the title, none
		 * of it configurable. Apply what the caller actually asked for.
		 **/
		applyInitConfig(initConfig, ctx) {

			const wp = (initConfig && initConfig.wp) || {};
			const run = (args) => runWpEnv(ctx.bin, ['run', 'cli', 'wp', ...splitForWpEnv(args)], { cwd: ctx.cwd });

			if (wp.title) {
				run(['option', 'update', 'blogname', wp.title]);
			}

			if (wp.adminEmail || wp.adminPassword) {
				const args = ['user', 'update', 'admin'];
				if (wp.adminEmail) args.push(`--user_email=${wp.adminEmail}`);
				if (wp.adminPassword) args.push(`--user_pass=${wp.adminPassword}`);
				run(args);
			}

			// wp-env's admin is always called `admin` and cannot be renamed. This
			// used to create an additional administrator instead, which left the
			// user with two accounts — the one they asked for, and the one that
			// actually had a password they knew. Refuse rather than half-oblige.
			//
			// --admin-user is rejected outright before init runs; reaching here
			// means WP_ADMIN_USER was set in the environment, which bypasses the
			// flag check.
			if (wp.adminUser && wp.adminUser !== 'admin') {
				log.warn(`wp-env's administrator is always \`admin\`, so "${wp.adminUser}" was not created.`);
				log.warn(`Log in as \`admin\`. Rename it afterwards if you need to: wp user update admin --user_login=...`);
			}
		},

		/**
		 * Run a WP-CLI command inside the cli container.
		 **/
		wpCli(cmd, opts) {
			const args = Array.isArray(cmd) ? cmd : String(cmd).split(/\s+/).filter(Boolean);
			return runWpEnv(bin(), ['run', 'cli', 'wp', ...splitForWpEnv(args)], {
				cwd: root(),
				silent: opts && opts.silent === false ? false : true,
			});
		},

		/**
		 * Bring the environment up and return — there is no foreground process
		 * to hold, unlike `wp server`.
		 **/
		async start() {

			const cwd = root();
			const port = readPort(cwd);

			log.info('Starting the Docker environment...');
			const started = runWpEnv(bin(), ['start'], { cwd, silent: false });

			// `ok` is new; the human path ignores it as it always has. JSON mode
			// needs it, or a start that failed would report the site as up.
			return {
				ok: started.code === 0,
				errors: started.code === 0 ? [] : [`wp-env could not start the environment.\n${started.stderr || started.stdout}`.trim()],
				url: `http://localhost:${port}`,
				detached: true,
			};
		},

		async stop() {
			log.info('Stopping the Docker environment...');
			const stopped = runWpEnv(bin(), ['stop'], { cwd: root(), silent: false });
			return stopped.code === 0;
		},

		/**
		 * Is the environment up?
		 *
		 * `wp-env status --json` answers from Docker itself, and knows the real
		 * URL and port. It arrived after 11.12, the oldest version projects pin,
		 * so when it is missing (or there is no wp-env binary at all) this falls
		 * back to connecting to the configured port from Node.
		 *
		 * That fallback can only ever prove a negative. Nothing answering means
		 * this environment is not serving; something answering means only that
		 * SOMETHING holds the port — most often another project's wp-env, the
		 * usual 8888 conflict. Reporting that as running told the app a
		 * never-started project was up, and turned doctor's port conflict into a
		 * pass. So a listener wp-env did not vouch for is `null`: unknown.
		 **/
		async status() {

			const cwd = root();
			const port = readPort(cwd);
			const fallback = { url: `http://localhost:${port}`, port, pid: null };
			const wpEnvBin = bin();

			if (wpEnvBin) {
				const reported = parseWpEnvStatus(runWpEnv(wpEnvBin, ['status', '--json'], { cwd }));
				if (reported) {
					return {
						...fallback,
						url: reported.url || fallback.url,
						port: reported.port || port,
						running: reported.running,
					};
				}
			}

			return { ...fallback, running: (await isPortListening(port)) ? null : false };
		},

		/**
		 * Remove the containers AND the volumes — the database goes with them.
		 *
		 * Must happen while the project directory still exists. wp-env derives
		 * an environment's identity from the path it was started in, so once the
		 * directory is gone there is nothing left to name the containers and
		 * volumes by, and they persist invisibly forever. That is why
		 * --clean-slate calls this before it wipes anything.
		 *
		 * `--scripts=false` because a destroyed environment has no scripts worth
		 * running, and wp-env's own confirmation is answered here: the caller has
		 * already asked.
		 **/
		async destroy() {
			log.info('Destroying the Docker environment (containers and database)...');

			const result = runWpEnv(bin(), ['destroy', '--scripts=false'], {
				cwd: root(),
				silent: false,
				input: 'y\n',
			});

			if (result.code !== 0) {

				// An environment that was never started, or already destroyed, is
				// the state this was asked to produce. Reporting failure meant a
				// torn-down project could never finish being torn down — the
				// config cleanup that follows was skipped, so it stayed pinned to
				// a backend whose containers were already gone.
				//
				// Matched on the message because wp-env collapses every non-zero
				// exit to 1, so the code cannot tell these apart. If the wording
				// ever changes this falls back to reporting a failure, which is
				// the safe direction to be wrong in.
				if (/not initialized/i.test(`${result.stderr} ${result.stdout}`)) {
					log.info('There was no running environment to destroy.');
					return { ok: true, errors: [] };
				}

				return { ok: false, errors: [`wp-env could not destroy this environment.\n${result.stderr || result.stdout}`] };
			}

			return { ok: true, errors: [] };
		},
	};
}

/**
 * Read `wp-env status --json`, or null when it gave nothing usable (an older
 * wp-env without the command exits non-zero).
 *
 * The JSON is the last `{` line: wp-env's spinner can leave chrome ahead of
 * it. `uninitialized` (never started here) and `stopped` both mean not
 * running.
 **/
export function parseWpEnvStatus(result) {

	if (!result || result.code !== 0) {
		return null;
	}

	const line = String(result.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{')).pop();
	if (!line) {
		return null;
	}

	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch (e) {
		return null;
	}

	if (!parsed || typeof parsed.status !== 'string') {
		return null;
	}

	return {
		running: parsed.status === 'running',
		url: (parsed.urls && parsed.urls.development) || null,
		port: (parsed.ports && Number(parsed.ports.development)) || null,
	};
}
