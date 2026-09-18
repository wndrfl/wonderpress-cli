import fs from 'fs-extra';
import path from 'path';
import sh from 'shelljs';
import * as log from './log.js';

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
	const cmd = locked ? 'composer install' : 'composer update';

	log.info(`Installing Composer packages (${cmd})...`);
	const result = sh.exec(cmd, { cwd: dir });

	if (result.code !== 0) {
		log.error(`Composer failed in ${dir}. Refusing to continue with missing dependencies.`);
		return false;
	}

	log.info('Composer is installed!');

	return true;
}
