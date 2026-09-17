import fs from 'fs-extra';
import net from 'net';
import path from 'path';
import sh from 'shelljs';
import { execFileSync } from 'child_process';
import * as log from '../log.js';

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

const DEFAULT_PORT = 8888;

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
export function resolveWpEnvBin(root) {

	const local = path.join(root || process.cwd(), 'node_modules', '.bin', 'wp-env');
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
 * Is a TCP port free? Bound on 0.0.0.0 because Docker publishes on every
 * interface — checking only loopback would miss a conflict.
 **/
export function isPortFree(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once('error', () => resolve(false));
		server.once('listening', () => server.close(() => resolve(true)));
		server.listen(port, '0.0.0.0');
	});
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
	const configPath = path.join(root, '.wp-env.json');
	try {
		return JSON.parse(fs.readFileSync(configPath, 'utf8')).port || DEFAULT_PORT;
	} catch (e) {
		return DEFAULT_PORT;
	}
}

/**
 * Run a wp-env subcommand. execFileSync rather than a shell string: wp-env
 * hands argv straight to spawn with no inner shell, so there is no quoting to
 * get wrong — which is strictly safer than the host backend's concatenation.
 **/
function runWpEnv(bin, args, opts = {}) {

	try {
		const stdout = execFileSync(bin, args, {
			cwd: opts.cwd || process.cwd(),
			encoding: 'utf8',
			// `input` replaces the inherited stdin, which is how wp-env's own
			// confirmation prompt gets answered without a human present.
			stdio: opts.input !== undefined
				? ['pipe', 'pipe', 'inherit']
				: (opts.silent === false ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'pipe', 'pipe']),
			input: opts.input,
			maxBuffer: 32 * 1024 * 1024,
		});
		return { code: 0, stdout: stdout || '', stderr: '', toString() { return stdout || ''; } };
	} catch (error) {
		const stdout = (error.stdout || '').toString();
		const stderr = (error.stderr || '').toString();
		// wp-env collapses every non-zero exit to 1, so the code carries no
		// more information than "it failed".
		return { code: error.status || 1, stdout, stderr, toString() { return stdout; } };
	}
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
		 * WonderPress — creates the first user, and never prompts for it. The
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

			const errors = [];

			if (!sh.which('docker')) {
				errors.push(`Docker is not installed, and \`--env wp-env\` needs it.\n  macOS / Windows   https://docs.docker.com/desktop/\n  Linux             https://docs.docker.com/engine/install/\nOr build the host environment instead: wonderpress init`);
			} else {
				// wp-env spawns `docker compose`; the old standalone
				// docker-compose v1 does not satisfy it.
				if (sh.exec('docker compose version', { silent: true }).code !== 0) {
					errors.push(`Docker is running, but the Compose v2 plugin is missing.\nwp-env runs \`docker compose\`, not \`docker-compose\`.\n  Install:  https://docs.docker.com/compose/install/`);
				}
				// `docker version` succeeds against a dead daemon, so this is
				// the check a PATH lookup misses.
				if (sh.exec('docker info', { silent: true }).code !== 0) {
					errors.push(`Docker is installed, but the daemon is not responding.\nStart Docker Desktop and wait for it to settle, then check: docker info\nNothing has been written yet, so re-run once Docker is up.`);
				}
			}

			// Deliberately NOT checking for the wp-env binary here. Preflight
			// runs before init has changed into the target directory, so a
			// project-local lookup would examine the wrong one — and the
			// binary is a devDependency this backend installs itself during
			// prepare(). Docker and WP-CLI are the things the user must supply.

			// Still required: `wp core download` runs on the HOST and must
			// happen before wp-env starts. wp-env replaces MySQL, not the PHP
			// toolchain.
			if (!sh.which('wp')) {
				errors.push(`Wonderpress leans heavily on the WP CLI. Please visit https://wp-cli.org/ and follow installation instructions before trying again.`);
			}

			return { ok: errors.length === 0, errors };
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
			const installed = sh.exec('npm install', { silent: true });

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
					errors: [`Port ${port} is already in use, so wp-env cannot start.\n  See what has it:  lsof -nP -iTCP:${port} -sTCP:LISTEN\n  Most likely another wp-env environment — run \`wp-env stop\` in that project.\nOr change "port" in .wp-env.json.`],
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
			runWpEnv(bin(), ['start'], { cwd, silent: false });

			return { url: `http://localhost:${port}`, detached: true };
		},

		async stop() {
			log.info('Stopping the Docker environment...');
			runWpEnv(bin(), ['stop'], { cwd: root(), silent: false });
			return true;
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
				return { ok: false, errors: [`wp-env could not destroy this environment.\n${result.stderr || result.stdout}`] };
			}

			return { ok: true, errors: [] };
		},
	};
}
