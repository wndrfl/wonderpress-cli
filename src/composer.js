import fs from 'fs-extra';
import path from 'path';
import sh from 'shelljs';
import * as log from './log.js';
import { runAsync } from './proc.js';

/**
 * Installs the Composer packages for a directory.
 *
 * Two directories need this during an init: the environment root, whose
 * composer.json carries the phpcs toolchain, and the theme, whose composer.json
 * carries wonderpress-core — the runtime dependency that used to be installed
 * by cloning it into mu-plugins.
 *
 * Prefers `install` over `update` whenever a lock file is present. `update`
 * resolves fresh against the constraints and rewrites the lock, so running it
 * on a locked project silently bumps dependencies that nobody asked to bump.
 * A pinned core that drifts on every scaffold is the exact failure the old
 * git-tag pin existed to prevent.
 *
 * @param {String} dir The directory holding composer.json. Defaults to the cwd.
 * @returns {Promise<Boolean>} True when the directory is ready to use.
 **/
export async function installComposer(dir = process.cwd()) {

	const manifest = path.join(dir, 'composer.json');

	// Nothing to install is a success, not a failure. The theme is allowed to
	// ship without a manifest, and callers should not have to check first.
	if (!fs.existsSync(manifest)) {
		return true;
	}

	log.info(`Checking for an existing Composer installation in ${dir}...`);

	// The autoloader, not the directory. A `vendor` that exists but is empty —
	// an interrupted install, a partial copy — used to read as "installed" and
	// leave the project broken in a way nothing reported.
	//
	// Note the original bug this replaces: `if (await !fs.existsSync(...))`
	// applies `!` before `await`, so the condition was `await false` and the
	// install never ran at all.
	if (fs.existsSync(path.join(dir, 'vendor', 'autoload.php'))) {
		log.info('Composer packages are already installed.');
		return true;
	}

	if (!sh.which('composer')) {
		log.error('Composer is not installed, or is not on your PATH. See https://getcomposer.org/download/');
		return false;
	}

	const locked = fs.existsSync(path.join(dir, 'composer.lock'));
	const verb = locked ? 'install' : 'update';

	log.info(`Installing Composer packages (composer ${verb})...`);
	// Async so `init --format json` can be cancelled mid-install (src/proc.js).
	const result = await runAsync('composer', [verb], { cwd: dir });

	if (result.code !== 0) {
		log.error(`Composer failed in ${dir}. Refusing to continue with missing dependencies.`);
		return false;
	}

	log.info('Composer is installed!');

	return true;
}

/**
 * Read a directory's composer.json, or null when there is none or it is not
 * JSON. A manifest that cannot be parsed is reported by Composer itself the
 * moment anything runs; here it only means "nothing to read".
 *
 * @param {String} dir The directory holding composer.json.
 * @returns {Object|null}
 **/
export function readManifest(dir) {
	const file = path.join(dir, 'composer.json');
	if (!fs.existsSync(file)) {
		return null;
	}
	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		return (data && typeof data === 'object') ? data : null;
	} catch (e) {
		return null;
	}
}

/**
 * The version constraint a directory's composer.json declares for a package,
 * or null when it does not require it. `require` only: a dev requirement of
 * wonderpress-core would be a mistake, not a configuration.
 *
 * @param {String} dir The directory holding composer.json.
 * @param {String} name The package, as vendor/name.
 * @returns {String|null}
 **/
export function declaredConstraint(dir, name) {
	const manifest = readManifest(dir);
	const require = manifest && manifest.require;
	const constraint = require && typeof require === 'object' ? require[name] : undefined;
	return typeof constraint === 'string' && constraint ? constraint : null;
}

/**
 * The version composer.lock resolved for a package, or null when there is no
 * lock file, it is not JSON, or it does not carry the package.
 *
 * Read from the lock rather than restated from a constant, so a record built
 * from it (.wonderpressrc's `core`) cannot drift from what Composer decided.
 *
 * @param {String} dir The directory holding composer.lock.
 * @param {String} name The package, as vendor/name.
 * @returns {String|null}
 **/
export function lockedVersion(dir, name) {
	const file = path.join(dir, 'composer.lock');
	if (!fs.existsSync(file)) {
		return null;
	}
	try {
		const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
		const pkg = (lock.packages || []).find((p) => p && p.name === name);
		return pkg && typeof pkg.version === 'string' ? pkg.version : null;
	} catch (e) {
		log.warn(`Could not read ${file}: ${e.message}`);
		return null;
	}
}

/**
 * The version actually present under vendor/, from Composer's own
 * vendor/composer/installed.json, or null when the package is not installed.
 *
 * Distinct from the lock: a lock file pulled from version control with a
 * vendor/ that was not updated alongside it says one version and ships
 * another. The theme commits both, so normally they agree, which is exactly
 * why the case where they do not is worth a line.
 *
 * @param {String} dir The directory holding vendor/.
 * @param {String} name The package, as vendor/name.
 * @returns {String|null}
 **/
export function installedVersion(dir, name) {
	const file = path.join(dir, 'vendor', 'composer', 'installed.json');
	if (!fs.existsSync(file)) {
		return null;
	}
	try {
		const data = JSON.parse(fs.readFileSync(file, 'utf8'));
		// Composer 2 wraps the list in { packages: [...] }; Composer 1 wrote the
		// bare array.
		const packages = Array.isArray(data) ? data : (data && Array.isArray(data.packages) ? data.packages : []);
		const pkg = packages.find((p) => p && p.name === name);
		return pkg && typeof pkg.version === 'string' ? pkg.version : null;
	} catch (e) {
		return null;
	}
}
