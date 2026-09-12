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
