import { spawn, spawnSync } from 'child_process';
import * as doctor from '../doctor.js';
import * as log from '../log.js';
import { buildSpawn, resolveBin, run } from '../proc.js';
import { buildWpCliArgv } from './command.js';
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
 * This is the behavior Wonderpress has always had. Every command below is the
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
			const { file, args } = buildWpCliArgv(['wp'], cmd);
			return run(file, args, { silent: !!(opts && opts.silent) });
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

			// Inherited stdio, stdin included: this is the user's foreground job.
			const result = run('wp', ['server'], { stdio: 'inherit' });

			return foregroundOutcome(result);
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

			const result = run('wp', ['db', 'drop', '--yes'], { silent: true });

			if (result.code !== 0) {
				// A database that was never created, or already dropped, is the
				// state we wanted anyway.
				log.warn(`The database could not be dropped — it may already be gone.\n${(result.stderr || '').trim()}`);
			}

			return { ok: true, errors: [] };
		},
	};
}

// The signals that mean "stop the server" when they reach the CLI: Ctrl-C,
// a supervisor's stop, a closed terminal. Each is passed on to the server's
// whole process group.
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * `wp server` as a child we can watch, for JSON mode.
 *
 * stdout of the child is wired to OUR stderr (fd 2): the JSON envelope must be
 * the only thing on stdout.
 *
 * `wp server` is WP-CLI, in PHP, and it does not serve anything itself: it
 * runs `php -S` as a child of its own, and that grandchild holds the port.
 * Signalling the CLI, or the `wp` process, used to leave `php -S` orphaned
 * and still listening — the next start then refused the port, and nothing
 * the user could see owned it. So the server is spawned as the leader of its
 * own process group (POSIX), the stop signals this process receives are
 * forwarded to the whole group, and when the leader exits for any reason the
 * group is swept so nothing it started outlives it. The reported pid is the
 * group leader, so `kill -TERM -<pid>` stops all of it from outside too.
 *
 * A new group also means the terminal's Ctrl-C no longer reaches the server
 * directly — it reaches this process, which forwards it. Same effect.
 *
 * `command`/`args` are injectable for tests, which stand a fake `wp` in for
 * WP-CLI.
 **/
export async function startObserved(url, onReady, { command = 'wp', args = ['server'] } = {}) {

	const target = urlTarget(url) || { host: 'localhost', port: 8080 };

	// Readiness is "the port answers", so a port that already answers would
	// make a server that is about to fail look ready. Refuse up front.
	if (await isPortListening(target.port, target.host)) {
		return { ok: false, running: null, url, detached: false, pid: null, errors: [`Something is already listening on port ${target.port}. Is the server already running? Check with: wonderpress server status`] };
	}

	// Process groups are POSIX. On Windows `wp` is a .bat shim that only
	// cmd.exe can run (buildSpawn escapes the line), there is no group to
	// signal, and the tree is killed with taskkill instead. The host backend is
	// unsupported there, but it should fail cleanly rather than throw.
	const posix = process.platform !== 'win32';
	const spec = buildSpawn(resolveBin(command), args);

	return new Promise((resolve) => {

		const child = spawn(spec.file, spec.args, {
			// No stdin: a process outside the terminal's foreground group that
			// reads from it is stopped by the kernel, and the server needs none.
			stdio: [posix ? 'ignore' : 'inherit', 2, 2],
			detached: posix,
			windowsHide: true,
			windowsVerbatimArguments: spec.windowsVerbatimArguments,
		});

		let ready = false;
		let exited = false;
		let timedOut = false;
		// The signal this process forwarded, if any: an exit that follows one
		// is a requested stop, not a crash, whatever code it exits with.
		let stopSignal = null;

		const signalServer = (signal) => {
			if (!child.pid) {
				return;
			}
			try {
				if (posix) {
					process.kill(-child.pid, signal);
				} else {
					// No signals and no groups on Windows: kill the tree (cmd.exe,
					// wp, php -S) by pid. Never process.kill(-pid), which throws
					// there.
					spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
				}
			} catch (e) {
				// ESRCH: the group is already gone, which is what was wanted.
			}
		};

		const forwarders = STOP_SIGNALS.map((signal) => {
			const forward = () => {
				stopSignal = signal;
				signalServer(signal);
			};
			process.on(signal, forward);
			return [signal, forward];
		});

		const finish = (result) => {
			for (const [signal, forward] of forwarders) {
				process.removeListener(signal, forward);
			}
			resolve(result);
		};

		child.once('error', (error) => {
			exited = true;
			finish({ ok: false, url, detached: false, pid: null, errors: [`Could not start wp server: ${error.message}`] });
		});

		child.once('exit', (code, signal) => {
			exited = true;

			// The leader is gone, however that happened (Ctrl-C, a forwarded
			// stop, a crash, someone killing the reported pid). Sweep the rest
			// of its group: this is what stops `php -S` when only `wp` died.
			if (posix) {
				signalServer('SIGTERM');
			}

			if (!ready) {
				const why = timedOut
					? `wp server did not answer on port ${target.port} within ${READY_TIMEOUT_MS / 1000}s.`
					: `wp server exited before it was ready (${signal || `code ${code}`}).`;
				finish({ ok: false, url, detached: false, pid: child.pid ?? null, errors: [why] });
				return;
			}
			finish({ ok: true, url, detached: false, pid: child.pid ?? null, exitCode: code, signal, stopSignal });
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
				// The group, not just `wp`: a `php -S` that is slow to bind
				// would otherwise be left behind to bind later, orphaned.
				timedOut = true;
				signalServer('SIGTERM');
				return;
			}
			setTimeout(poll, 200);
		};
		poll();
	});
}

/**
 * What a foreground `wp server` run amounts to, once it has returned.
 *
 * A stop by signal (Ctrl-C) is the normal way out and is success. A missing
 * `wp` (run() has already printed why) or a non-zero exit — no wp-config, the
 * port taken — is a failure, and the process exit code must say so: `execSync`
 * used to throw here, and an argv spawn does not.
 **/
export function foregroundOutcome(result) {
	if (!result || result.signal || result.code === 0) {
		return { url: null, detached: false };
	}
	const reason = result.code === 127
		? 'WP-CLI (`wp`) was not found on PATH.'
		: `The development server exited with code ${result.code}.`;
	log.error(reason);
	process.exitCode = 1;
	return { ok: false, errors: [reason], url: null, detached: false };
}
