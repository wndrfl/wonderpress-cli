import fs from 'fs-extra';
import path from 'path';
import * as config from '../config.js';
import * as host from './host.js';
import * as wpEnv from './wp-env.js';

/**
 * The environment backend registry.
 *
 * A backend is everything that differs between "WordPress on this machine" and
 * "WordPress in a container": the preflight check, the provisioning graph, how
 * a WP-CLI command is run, and how the site is served. Commands ask for the
 * current backend rather than shelling out to `wp` themselves.
 *
 * The current backend is module state rather than a parameter because the
 * functions that need it — `isInstalled()` above all — are called from five
 * places with no arguments, and their signatures are pinned by existing tests.
 **/
const BACKENDS = {
	host: host.create,
	'wp-env': wpEnv.create,
};

let current = null;

/**
 * Every registered backend name.
 **/
export function names() {
	return Object.keys(BACKENDS);
}

/**
 * Make a backend current. Accepts a name, or a backend object directly so a
 * test can inject a recording fake.
 **/
export function activate(backendOrName) {

	if (backendOrName && typeof backendOrName === 'object') {
		current = backendOrName;
		return current;
	}

	const name = backendOrName || 'host';
	const factory = BACKENDS[name];

	if (!factory) {
		throw new Error(`Unknown environment backend: ${name} (expected one of: ${names().join(', ')})`);
	}

	current = factory();
	return current;
}

/**
 * The current backend, defaulting to the host.
 *
 * Lazily defaulting here rather than requiring an explicit activate() is what
 * lets code paths that never resolve a backend keep behaving exactly as they
 * did before the seam existed.
 **/
export function getCurrent() {
	return current || activate('host');
}

/**
 * Forget the current backend. For tests.
 **/
export function reset() {
	current = null;
}

export const DEFAULT_BACKEND = 'host';

/**
 * Decide which backend an invocation should use. Pure — the caller does the I/O
 * and hands the answers in.
 *
 * Highest wins:
 *   1. --env flag
 *   2. WONDERPRESS_ENV          (same tier as the flag: a per-invocation
 *                                override for CI and per-developer preference)
 *   3. the backend recorded in .wonderpressrc
 *   4. a .wp-env.json at the environment root
 *   5. host
 *
 * Tier 4 is what keeps an environment working after a `git checkout` reverts
 * the recorded key. Tier 5 is why this is safe to ship: every WonderPress site
 * built to date has no marker of any kind, and resolves to the backend it has
 * always used.
 *
 * `mismatch` is set when an explicit choice contradicts what the environment
 * was built with — running `wp server` against a Docker-provisioned tree fails
 * bewilderingly otherwise.
 **/
export function resolveBackendName({ flag, envVar, persisted, detected } = {}) {

	const known = (value) => (value && names().includes(value) ? value : null);

	const explicit = known(flag) ? 'flag' : (known(envVar) ? 'env' : null);
	const chosen =
		explicit === 'flag' ? flag :
		explicit === 'env' ? envVar :
		known(persisted) ? persisted :
		known(detected) ? detected :
		DEFAULT_BACKEND;

	const source =
		explicit ||
		(known(persisted) ? 'persisted' : (known(detected) ? 'detected' : 'default'));

	return {
		name: chosen,
		source,
		persisted: known(persisted),
		mismatch: !!(explicit && known(persisted) && persisted !== chosen),
		// An unrecognised value is not silently ignored — the caller reports it.
		unknown: (flag && !known(flag)) ? flag : ((envVar && !known(envVar)) ? envVar : null),
	};
}

/**
 * Resolve and activate the backend for an environment rooted at `root`.
 *
 * Does the I/O that resolveBackendName() deliberately does not: reads the
 * recorded backend and looks for a .wp-env.json. Returns the resolution so the
 * caller can report an unknown name or a mismatch.
 **/
export function resolve({ flag, envVar, root } = {}) {

	const dir = root || process.cwd();

	const resolution = resolveBackendName({
		flag,
		envVar,
		persisted: config.getBackend(dir),
		detected: fs.existsSync(path.join(dir, '.wp-env.json')) ? 'wp-env' : null,
	});

	if (!resolution.unknown) {
		activate(resolution.name);
	}

	return resolution;
}
