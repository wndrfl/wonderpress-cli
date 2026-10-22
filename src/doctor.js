import fs from 'fs-extra';
import path from 'path';
import sh from 'shelljs';
import * as composer from './composer.js';
import * as config from './config.js';
import * as format from './format.js';
import * as log from './log.js';
import { isPortFree } from './env/probe.js';
import { portOwnerCommand, run as runProcess } from './proc.js';

/**
 * `wonderpress doctor` — every prerequisite check, in one place.
 *
 * These used to live inside each backend's preflight(), where they could only
 * be seen by running `init` and failing. The app's onboarding needs the same
 * answers as a checklist before anything is built, so the checks moved here and
 * the backends' preflight() became thin wrappers over them. `init` still calls
 * backend.preflight(), so it now goes through this module, and the messages a
 * failed init prints are the exact strings it printed before (they are the
 * checks' hints).
 *
 * A check is:
 *   { check, label, ok, backend, platform, hint, detail }
 * `backend` and `platform` say where the check APPLIES ('any' when everywhere),
 * not where it ran. `hint` is how to fix a failure (null when passing, or when
 * the check was not reached because one it depends on failed). `detail` is what
 * was found.
 **/

export const BACKENDS = ['host', 'wp-env'];

// The wording of these is load-bearing: they are what `init` has always
// printed when its preflight failed, and tests pin them.
export const HINTS = {
	wpCli: `Wonderpress leans heavily on the WP CLI. Please visit https://wp-cli.org/ and follow installation instructions before trying again.`,
	docker: `Docker is not installed, and \`--env wp-env\` needs it.\n  macOS / Windows   https://docs.docker.com/desktop/\n  Linux             https://docs.docker.com/engine/install/\nOr build the host environment instead: wonderpress init`,
	compose: `Docker is running, but the Compose v2 plugin is missing.\nwp-env runs \`docker compose\`, not \`docker-compose\`.\n  Install:  https://docs.docker.com/compose/install/`,
	daemon: `Docker is installed, but the daemon is not responding.\nStart Docker Desktop and wait for it to settle, then check: docker info\nNothing has been written yet, so re-run once Docker is up.`,
	// The same sentence installComposer prints when it finds no Composer
	// mid-init — after the clone and npm install, which is what doctor and
	// preflight exist to head off.
	composer: `Composer is not installed, or is not on your PATH. See https://getcomposer.org/download/`,
	hostOnWindows: `The host backend is not supported on Windows.\nUse the Docker backend instead: wonderpress init --env wp-env`,
	// What `init` prints instead on Windows: doctor's sentence, plus why it
	// carries on. The CLI warns and lets a determined user try; the app is
	// where this blocks (onboarding), because the app cannot help them when it
	// fails. See ARCHITECTURE.md, "Cross-platform support".
	hostOnWindowsInit: `The host backend is not supported on Windows. It may work, but nothing tests it there.\nUse the Docker backend instead: wonderpress init --env wp-env\nContinuing with the host backend.`,
};

/**
 * The port-conflict message wp-env's provision() prints. Lives here so doctor
 * and provision say the same thing.
 **/
export function portInUseHint(port, platform = process.platform) {
	return `Port ${port} is already in use, so wp-env cannot start.\n  See what has it:  ${portOwnerCommand(port, platform)}\n  Most likely another wp-env environment — run \`wp-env stop\` in that project.\nOr change "port" in .wp-env.json.`;
}

/**
 * Real I/O. Injected so tests can drive every branch without Docker, WP-CLI or
 * a particular operating system.
 **/
export const defaultDeps = {
	which(bin) {
		const found = sh.which(bin);
		return found ? String(found) : null;
	},
	exec(bin, args = []) {
		const result = runProcess(bin, args, { silent: true });
		return { code: result.code, stdout: result.stdout || '', stderr: result.stderr || '' };
	},
	isPortFree,
};

function check(fields) {
	return {
		check: fields.check,
		label: fields.label,
		ok: !!fields.ok,
		backend: fields.backend || 'any',
		platform: fields.platform || 'any',
		hint: fields.ok ? null : (fields.hint ?? null),
		detail: fields.detail ?? null,
	};
}

function firstLine(text) {
	return String(text || '').trim().split('\n')[0] || null;
}

function wpCliCheck(deps) {
	const found = deps.which('wp');
	return check({
		check: 'wp-cli',
		label: 'WP-CLI on PATH',
		ok: !!found,
		backend: 'any',
		hint: HINTS.wpCli,
		detail: found || 'wp was not found on PATH.',
	});
}

/**
 * Composer installs the theme's PHP dependencies (wonderpress-core among them)
 * on the host, under either backend — wp-env does not run it inside the
 * container. init only reaches that step after cloning the scaffold and
 * installing npm packages, so a missing Composer used to surface late.
 **/
function composerCheck(deps) {
	const found = deps.which('composer');
	return check({
		check: 'composer',
		label: 'Composer on PATH',
		ok: !!found,
		backend: 'any',
		hint: HINTS.composer,
		detail: found || 'composer was not found on PATH.',
	});
}

/**
 * The host backend's checks.
 *
 * On Windows, one failing check and nothing else. A checklist of PHP, MySQL
 * and WP-CLI items that can never all pass there is worse than one sentence
 * saying to use the Docker backend.
 **/
function hostChecks(deps, platform) {
	if (platform === 'win32') {
		return [check({
			check: 'host-platform',
			label: 'Host backend on this platform',
			ok: false,
			backend: 'host',
			platform: 'win32',
			hint: HINTS.hostOnWindows,
			detail: 'The host backend runs PHP, MySQL and WP-CLI natively, which is supported on macOS and Linux only.',
		})];
	}
	return [wpCliCheck(deps), composerCheck(deps)];
}

/**
 * The wp-env backend's checks: Docker, Compose v2, a live daemon, and — still —
 * WP-CLI, because `wp core download` runs on the host before wp-env starts, and
 * Composer, which installs the theme's packages on the host too.
 *
 * Deliberately NOT checking for the wp-env binary. It is a devDependency the
 * backend installs itself during prepare(), and preflight runs before init has
 * changed into the target directory, so a project-local lookup would examine
 * the wrong one.
 **/
async function wpEnvChecks(deps, opts) {

	const checks = [];
	const docker = deps.which('docker');

	checks.push(check({
		check: 'docker',
		label: 'Docker installed',
		ok: !!docker,
		backend: 'wp-env',
		hint: HINTS.docker,
		detail: docker || 'docker was not found on PATH.',
	}));

	if (docker) {
		// wp-env spawns `docker compose`; the old standalone docker-compose v1
		// does not satisfy it.
		const compose = deps.exec('docker', ['compose', 'version']);
		checks.push(check({
			check: 'docker-compose',
			label: 'Docker Compose v2',
			ok: compose.code === 0,
			backend: 'wp-env',
			hint: HINTS.compose,
			detail: firstLine(compose.code === 0 ? compose.stdout : (compose.stderr || compose.stdout)),
		}));

		// `docker version` succeeds against a dead daemon, so this is the check
		// a PATH lookup misses.
		const info = deps.exec('docker', ['info']);
		checks.push(check({
			check: 'docker-daemon',
			label: 'Docker daemon running',
			ok: info.code === 0,
			backend: 'wp-env',
			hint: HINTS.daemon,
			detail: info.code === 0 ? 'docker info succeeded.' : firstLine(info.stderr || info.stdout),
		}));
	} else {
		// Reported rather than omitted, so the checklist has the same rows
		// whatever state the machine is in. No hint: the fix is the Docker
		// check's, and repeating it three times helps nobody.
		for (const [id, label] of [['docker-compose', 'Docker Compose v2'], ['docker-daemon', 'Docker daemon running']]) {
			checks.push(check({ check: id, label, ok: false, backend: 'wp-env', hint: null, detail: 'Not checked: Docker is not installed.' }));
		}
	}

	checks.push(wpCliCheck(deps));
	checks.push(composerCheck(deps));

	// The port check only means something once there is a port to check, so
	// preflight (which runs before .wp-env.json exists) leaves it out, and
	// provision() checks it at the point it starts the containers.
	if (opts.port) {
		const free = await deps.isPortFree(opts.port);
		let ok = free;
		let detail = free ? `Port ${opts.port} is free.` : `Port ${opts.port} is in use.`;

		// A running project holds its own port. That is the healthy state, not
		// a conflict, so ask before failing it.
		if (!free && typeof opts.ownEnvironmentRunning === 'function') {
			let own = false;
			try {
				own = !!(await opts.ownEnvironmentRunning());
			} catch (e) {
				own = false;
			}
			if (own) {
				ok = true;
				detail = `Port ${opts.port} is in use by this project's own environment.`;
			}
		}

		checks.push(check({
			check: 'wp-env-port',
			label: `Port ${opts.port} available`,
			ok,
			backend: 'wp-env',
			hint: portInUseHint(opts.port, opts.platform || process.platform),
			detail,
		}));
	}

	return checks;
}

/**
 * Does .wonderpressrc still say which core the theme runs?
 *
 * `init` records the version composer.lock resolved for wonderpress-core;
 * `wonderpress core update` re-records it. A bare `composer update` in the
 * theme does not, and that is the drift this check exists to name: a project
 * whose record claims one version while its lock resolves another.
 *
 * Project-level, so it only runs inside a project (`root`). The package name
 * and the themes directory arrive as arguments rather than through imports of
 * core.js and wordpress.js, both of which would make a cycle (core → env →
 * backends → doctor). cli.js supplies them from those modules. Every theme on disk that requires
 * the package is compared; a theme without it is not core's concern.
 **/
export function coreRecordCheck(root, name, themesDir) {
	const recorded = (() => {
		const value = config.read(root).data.core;
		return typeof value === 'string' && value ? value : null;
	})();

	const themes = fs.existsSync(themesDir)
		? fs.readdirSync(themesDir).filter((entry) => fs.existsSync(path.join(themesDir, entry, 'style.css')))
		: [];
	const declaring = themes
		.map((theme) => ({ theme, dir: path.join(themesDir, theme) }))
		.filter(({ dir }) => composer.declaredConstraint(dir, name));

	const row = (fields) => check({ check: 'core-record', label: `${name} record matches composer.lock`, backend: 'any', ...fields });

	if (!declaring.length) {
		return row({ ok: true, detail: `No theme requires ${name}; nothing to compare.` });
	}

	const unlocked = declaring.filter(({ dir }) => !composer.lockedVersion(dir, name));
	if (unlocked.length) {
		return row({
			ok: false,
			hint: `composer.lock does not resolve ${name} in ${unlocked.map((t) => t.theme).join(', ')}.\nRun \`composer install\` in the theme, or \`wonderpress core update\`.`,
			detail: `${unlocked.map((t) => t.theme).join(', ')}: composer.lock has no entry for ${name}.`,
		});
	}

	const locked = declaring.map(({ theme, dir }) => ({ theme, version: composer.lockedVersion(dir, name) }));
	const drifted = locked.filter(({ version }) => version !== recorded);
	if (drifted.length) {
		return row({
			ok: false,
			hint: `.wonderpressrc records ${recorded ?? 'no core version'}, but composer.lock resolves ${drifted.map((t) => `${t.version} (${t.theme})`).join(', ')}.\nRun \`wonderpress core update\` to bring the lock and the record current together.`,
			detail: `recorded ${recorded ?? 'nothing'}; locked ${locked.map((t) => `${t.version} (${t.theme})`).join(', ')}.`,
		});
	}

	return row({ ok: true, detail: `${recorded} in ${locked.map((t) => t.theme).join(', ')}.` });
}

/**
 * Run the checks for one backend, or for every backend when `backend` is null.
 *
 * Every-backend mode is for outside a project, where nothing has decided yet.
 * On Windows it leaves the host out entirely rather than reporting a check
 * that fails by design: there, the only real choice is wp-env.
 *
 * @param {'host'|'wp-env'|null} backend
 * @param {{ platform?: string, port?: number|null, ownEnvironmentRunning?: Function, deps?: object, projectRoot?: string|null, corePackage?: string }} [opts]
 *   `projectRoot` + `corePackage` add the core-record check (see coreRecordCheck).
 * @returns {Promise<{ backend: string|null, platform: string, ok: boolean, checks: object[] }>}
 **/
export async function run(backend, opts = {}) {

	const platform = opts.platform || process.platform;
	const deps = { ...defaultDeps, ...(opts.deps || {}) };

	const selected = backend ? [backend] : BACKENDS.filter((name) => !(platform === 'win32' && name === 'host'));
	const checks = [];

	for (const name of selected) {
		const found = name === 'host'
			? hostChecks(deps, platform)
			: await wpEnvChecks(deps, { ...opts, platform });
		for (const c of found) {
			// WP-CLI and Composer are required by both backends; list them once.
			if (!checks.some((existing) => existing.check === c.check)) {
				checks.push(c);
			}
		}
	}

	// Project-level, after the machine-level rows: only meaningful inside a
	// project, and only when the caller said which package and themes directory.
	if (opts.projectRoot && opts.corePackage && opts.themesDir) {
		checks.push(coreRecordCheck(opts.projectRoot, opts.corePackage, opts.themesDir));
	}

	return {
		backend: backend || null,
		platform,
		ok: checks.every((c) => c.ok),
		checks,
	};
}

/**
 * What a backend's preflight() returns: { ok, errors, warnings? }, the errors being the
 * failing checks' hints. A failure with no hint was not reached (Docker
 * missing makes the Compose and daemon checks moot), so it adds no message —
 * which is exactly what the old inline preflight printed.
 **/
export async function preflight(backend, opts = {}) {

	// The host backend on Windows: doctor reports it as a failing check (one
	// sentence, nothing else), but init only warns and carries on — the plan's
	// "unsupported, may work". What can still be checked is checked, so a
	// Windows machine with no WP-CLI fails here rather than halfway through.
	const platform = opts.platform || process.platform;
	if (backend === 'host' && platform === 'win32') {
		const deps = { ...defaultDeps, ...(opts.deps || {}) };
		const checks = [wpCliCheck(deps), composerCheck(deps)];
		return {
			ok: checks.every((c) => c.ok),
			errors: checks.filter((c) => !c.ok && c.hint).map((c) => c.hint),
			warnings: [HINTS.hostOnWindowsInit],
		};
	}

	const report = await run(backend, { ...opts, port: null });
	return {
		ok: report.ok,
		errors: report.checks.filter((c) => !c.ok && c.hint).map((c) => c.hint),
	};
}

/**
 * `wonderpress doctor`.
 *
 * @param {Record<string, unknown>} args
 * @param {{ backend: string|null, platform?: string, port?: number|null, ownEnvironmentRunning?: Function, deps?: object }} ctx
 *   Resolved by cli.js: the project's backend (or --env / WONDERPRESS_ENV), or
 *   null outside a project to check every backend.
 **/
export async function command(args, ctx = {}) {

	const report = await run(ctx.backend || null, ctx);
	const failed = report.checks.filter((c) => !c.ok);
	const scope = report.backend || 'all backends';

	if (format.isJson()) {
		if (report.ok) {
			return format.ok(report);
		}
		return format.fail({
			code: 'doctor',
			message: `${failed.length} of ${report.checks.length} checks failed.`,
			hint: failed.find((c) => c.hint)?.hint ?? null,
		}, format.EXIT_FAIL, report);
	}

	// Failures only. A wall of green ticks buries the one line that matters.
	for (const c of failed) {
		log.error(c.hint ? `${c.label}\n${c.hint}` : `${c.label} — ${c.detail}`);
	}

	if (report.ok) {
		log.success(`All ${report.checks.length} checks passed (${scope}, ${report.platform}).`);
		return true;
	}

	log.raw('');
	log.warn(`${failed.length} of ${report.checks.length} checks failed (${scope}, ${report.platform}).`);
	process.exitCode = format.EXIT_FAIL;
	return false;
}
