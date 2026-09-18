import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';
import sh from 'shelljs';
import * as config from './config.js';
import * as core from './core.js';
import * as env from './env/index.js';
import inquirer from 'inquirer';
import mysql2 from 'mysql2/promise';
import rc from 'rc';
import sqlString from 'sqlstring';

// Common paths
export const pathToThemesDir = './wp-content/themes';
export const pathToMuPluginsDir = './wp-content/mu-plugins';

/**
 * Theme directories on disk, identified the way WordPress identifies a theme:
 * a style.css in the directory root.
 *
 * On disk, not via WP-CLI, deliberately: callers need this before WordPress is
 * necessarily bootable — `init` installs a theme's Composer dependencies before
 * it activates anything, and `lint` is a static pass that never boots WordPress
 * at all.
 *
 * @returns {String[]} Theme directory names, not paths.
 **/
export function themesOnDisk() {

	if (! fs.existsSync(pathToThemesDir)) return [];

	return fs.readdirSync(pathToThemesDir).filter((entry) => {
		return fs.existsSync(`${pathToThemesDir}/${entry}/style.css`);
	});
}

/**
 * Activate a specific theme.
 **/
export async function activateTheme(themeName) {
	log.info('Attempting to activate theme: ' + themeName);
	env.getCurrent().wpCli(['theme', 'activate', themeName]);
}

/**
 * Create and setup a wp-config.php.
 *
 * Accepts a resolved init config. In interactive mode any unprovided credential
 * is prompted (retrying on failure); in non-interactive mode credentials come
 * from the config and a failure aborts rather than looping.
 **/
export async function configureWordPress(config) {

	config = config || {};
	const interactive = config.interactive !== false;
	const db = config.db || {};

	if (await this.hasConfig()) {
		log.info(`A wp-config.php already exists. Skipping WordPress configuration...`);

		// Skipping the CONFIG is not the same as skipping the DATABASE. The two
		// are independent facts, and `wonderpress destroy` produces exactly the
		// state where they disagree: it drops the database and leaves the config
		// behind, because the config may carry a project's own constants and is
		// not ours to delete. Returning true here left that project unrebuildable
		// — `init` reported success at this step, then failed to install against
		// a database nobody had recreated.
		return await ensureDatabaseFromConfig();
	}

	// Resolve DB credentials and open a connection.
	let connection = false;
	let creds = { host: db.host, user: db.user, password: db.password };

	while (!connection) {

		if (interactive && (creds.host === undefined || creds.user === undefined || creds.password === undefined)) {
			const answers = await inquirer.prompt([
				{ type: 'input', name: 'dbHost', message: 'What is the database hostname?', default: creds.host ?? 'localhost' },
				{ type: 'input', name: 'dbUser', message: 'What is the database username?', default: creds.user ?? 'root', validate: (input) => input !== '' },
				{ type: 'input', name: 'dbPassword', message: 'What is the database password?', default: creds.password ?? '' },
			]);
			creds = { host: answers.dbHost, user: answers.dbUser, password: answers.dbPassword };
		}

		// Fill any still-unset values (headless) with defaults.
		creds.host = creds.host ?? 'localhost';
		creds.user = creds.user ?? 'root';
		creds.password = creds.password ?? '';

		connection = await mysql2.createConnection({
			host: creds.host,
			user: creds.user,
			password: creds.password,
		}).catch(() => false);

		if (!connection) {
			log.error('The hostname / username / password combination you entered wasn\'t correct.');
			if (!interactive) {
				return false;
			}
			creds = { host: undefined, user: undefined, password: undefined };
		}
	}

	// Resolve the database name, creating it if needed.
	let dbName = db.name;
	let validDatabase = false;

	while (!validDatabase) {

		if (interactive && dbName === undefined) {
			const answers = await inquirer.prompt([
				{ type: 'input', name: 'dbName', message: 'What is the database name?', default: 'wonderpress' },
			]);
			dbName = answers.dbName;
		}
		dbName = dbName ?? 'wonderpress';

		const [rows] = await connection.execute(
			"SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?",
			[dbName]
		).catch((err) => { log.error(err.message); return [[]]; });

		if (rows.length) {
			validDatabase = true;
			continue;
		}

		// Database is missing — create it? (auto-create when headless)
		let doCreate = !interactive;
		if (interactive) {
			const answer = await inquirer.prompt([
				{ type: 'confirm', name: 'confirm', message: 'The database `' + dbName + '` doesn\'t exist, would you like to create it?', default: true },
			]);
			doCreate = answer.confirm;
		}

		if (!doCreate) {
			if (!interactive) { connection.end(); return false; }
			dbName = undefined;
			continue;
		}

		const created = await connection.execute("CREATE DATABASE " + sqlString.escapeId(dbName))
			.then(() => true)
			.catch((err) => { log.error(err.message); return false; });

		if (created) {
			log.success('The database `' + dbName + '` was created!');
			validDatabase = true;
		} else if (!interactive) {
			connection.end();
			return false;
		} else {
			dbName = undefined;
		}
	}

	connection.end();

	// Use WP CLI to create the wp-config.php file
	let wpConfigCreateCmd = 'wp config create';
	wpConfigCreateCmd += ' --dbhost=' + creds.host;
	wpConfigCreateCmd += ' --dbuser=' + creds.user;
	wpConfigCreateCmd += ' --dbpass=' + creds.password;
	wpConfigCreateCmd += ' --dbname=' + dbName;
	const configResult = sh.exec(wpConfigCreateCmd);
	if (configResult.code !== 0) {
		log.error('Failed to create wp-config.php.');
		return false;
	}

	return true;
}

/**
 * Create the themes directory
 **/
export async function createThemesDirectory() {

	if (! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	if (! await this.isInstalled()) {
		log.error('WordPress is not installed. Please install WordPress, first.');
		return false;
	}

	await fs.ensureDirSync(pathToMuPluginsDir);

	return true;
}

/**
 * Download WordPress core (without wp-content)
 **/
export async function downloadWordPress() {
	sh.exec('wp core download --skip-content --force');
	return true;
}

/**
 * Get the active theme
 **/
export async function getActiveTheme(opts) {

	// `quiet` is for callers that have a sensible fallback when WordPress
	// cannot answer — lint can still analyse files on disk — and should not
	// print "install WordPress" on the way to succeeding.
	const quiet = !!(opts && opts.quiet);

	if (!quiet) log.info('Grabbing the currently active theme...');

	if (! await this.isInstalled()) {
		if (!quiet) log.error('WordPress is not installed. Please install WordPress, first.');
		return false;
	}

	const activeResult = env.getCurrent().wpCli(['theme', 'list', '--status=active', '--format=json'], { silent: true });
	let themes = JSON.parse(activeResult.stdout);

	if (!themes.length) {
		log.error('There are no active themes.');
		return false;
	}

	if (themes.length > 1) {
		log.error('Somehow there is more than 1 active theme. Beats me.');
		return false;
	}

	log.info('Current active theme: ' + themes[0].name);
	return themes[0];
}

/**
 * Get a list of all installed themes
 **/
export async function getAllThemes() {
	try {
		const result = env.getCurrent().wpCli(['theme', 'list', '--format=json'], { silent: true });
		let themes = JSON.parse(result.stdout);
		return themes;
	} catch (e) {
		return [];
	}
}

/**
 * Check for the existense of a wp-config.php
 *
 * Silent because a miss is the expected case on a fresh install: `wp config
 * path` exits non-zero and prints "Error: 'wp-config.php' not found", which
 * shelljs would otherwise echo, making a routine probe look like a failure
 * moments before `init` goes on to write the file.
 **/
export async function hasConfig() {
	const result = sh.exec('wp config path', { silent: true });
	return result.code === 0;
}

/**
 * Make sure the database an existing wp-config.php names actually exists.
 *
 * Credentials are read back OUT of the config rather than taken from flags or
 * prompts. On a rebuild the answer is already written down, and asking again
 * invites someone to type a different database name than the config points at
 * — which would "succeed" and then fail to install, the same class of problem
 * this is here to fix.
 **/
export async function ensureDatabaseFromConfig() {

	const read = (key) => {
		const result = sh.exec(`wp config get ${key}`, { silent: true });
		return result.code === 0 ? result.stdout.trim() : null;
	};

	const name = read('DB_NAME');

	if (!name) {
		log.warn('Could not read DB_NAME out of wp-config.php, so the database could not be checked.');
		return true;
	}

	const mysql2 = (await import('mysql2/promise')).default;
	const sqlString = (await import('sqlstring')).default;

	let connection;
	try {
		connection = await mysql2.createConnection({
			host: read('DB_HOST') || 'localhost',
			user: read('DB_USER') || 'root',
			password: read('DB_PASSWORD') || '',
		});
	} catch (err) {
		log.error(`Could not reach the database server to check for \`${name}\`: ${err.message}`);
		return false;
	}

	try {
		const [rows] = await connection.query('SHOW DATABASES LIKE ?', [name]);

		if (rows.length) {
			return true;
		}

		log.info(`The database \`${name}\` is named in wp-config.php but does not exist. Creating it...`);
		await connection.execute('CREATE DATABASE ' + sqlString.escapeId(name));
		log.success('The database `' + name + '` was created!');
		return true;
	} catch (err) {
		log.error(`Could not create the database \`${name}\`: ${err.message}`);
		return false;
	} finally {
		await connection.end();
	}
}

/**
 * Install WordPress.
 *
 * Accepts a resolved init config. Interactive mode prompts only for the install
 * parameters not already supplied via flags/env; non-interactive uses the
 * config values (defaults filling any gaps) and runs unattended.
 **/
export async function installWordPress(config) {

	config = config || {};
	const interactive = config.interactive !== false;
	const wp = config.wp || {};

	if (await this.isInstalled()) {
		log.info('WordPress is already installed...');
		return;
	}

	let vals = {
		url: wp.url,
		title: wp.title,
		adminUser: wp.adminUser,
		adminPassword: wp.adminPassword,
		adminEmail: wp.adminEmail,
	};

	if (interactive) {
		const answers = await inquirer.prompt([
			{ type: 'input', name: 'url', message: 'What is the url you would like to use for development?', default: 'wonderpress.localhost', validate: (input) => input !== '', when: () => vals.url === undefined },
			{ type: 'input', name: 'title', message: 'What is the title of the site?', default: 'wonderpress', validate: (input) => input !== '', when: () => vals.title === undefined },
			{ type: 'input', name: 'adminUser', message: 'What is the admin username?', default: 'admin', when: () => vals.adminUser === undefined },
			{ type: 'input', name: 'adminPassword', message: 'What is the admin password?', default: 'supersecure', when: () => vals.adminPassword === undefined },
			{ type: 'input', name: 'adminEmail', message: 'What is the admin email?', default: 'example@example.com', when: () => vals.adminEmail === undefined },
		]);
		vals = { ...vals, ...answers };
	}

	// Fill any still-unset values (headless) with defaults.
	vals.url = vals.url ?? 'wonderpress.localhost';
	vals.title = vals.title ?? 'wonderpress';
	vals.adminUser = vals.adminUser ?? 'admin';
	vals.adminPassword = vals.adminPassword ?? 'supersecure';
	vals.adminEmail = vals.adminEmail ?? 'example@example.com';

	let wpInstallCmd = 'wp core install';
	wpInstallCmd += ' --url=' + vals.url;
	wpInstallCmd += ' --title=' + JSON.stringify(vals.title);
	wpInstallCmd += ' --admin_user=' + vals.adminUser;
	wpInstallCmd += ' --admin_password=' + vals.adminPassword;
	wpInstallCmd += ' --admin_email=' + vals.adminEmail;
	const installResult = sh.exec(wpInstallCmd);
	if (installResult.code !== 0) {
		log.error('WordPress installation failed.');
		return false;
	}

	return true;
}

/**
 * Install a specific plugin and optionally activate
 **/
export async function installPlugin(url, activate) {
	let cmd = `wp plugin install ${url}`;
	if (activate) {
		cmd += ` --activate`;
	}
	sh.exec(cmd);
}

/**
 * Install an MU (Must Use) Plugin.
 *
 * `ref` pins what gets installed. Cloning a moving branch means two projects
 * scaffolded a fortnight apart silently get different code, and no way to say
 * which one a client site is running or to upgrade it deliberately — so the
 * caller names a tag, and `init` records it (see core.js).
 *
 * A ref that does not exist fails loudly rather than falling back to the
 * default branch: silently installing something other than what was asked for
 * is the failure this exists to prevent.
 **/
export async function installMuPlugin(url, ref = null) {

	log.info(`Installing MU Plugin: ${url}${ref ? ` @ ${ref}` : ''}...`);

	await fs.ensureDirSync(pathToMuPluginsDir);

	const tmpDir = '.wonderpress-tmp';
	await fs.emptyDirSync(tmpDir);

	const refArg = ref ? ` --branch ${ref}` : '';
	const cmd = `git clone ${url}${refArg} ${tmpDir} --depth=1 --progress --verbose`;
	const cloned = sh.exec(cmd);

	if (cloned.code !== 0) {
		log.error(`Could not install ${url}${ref ? ` at ${ref}` : ''}. Refusing to continue with a different version than the one requested.`);
		return false;
	}

	// Check to see if the plugin has a .wonderpressrc
	const saveCwd = process.cwd();
	process.chdir(tmpDir);
	const wonderpressConfig = rc('wonderpress', {
		//
	});
	process.chdir(saveCwd);

	// Copy a filtered list of files
	await fs.copySync(tmpDir, pathToMuPluginsDir, {
		filter: (src, dest) => {

			// Always copy if no config
			if (!wonderpressConfig || !wonderpressConfig.ignore) {
				return true;
			}

			// Ignore specific files
			const basename = src.split(/[\\/]/).pop();
			return !wonderpressConfig.ignore.includes(basename);
		}
	});
	await fs.removeSync(tmpDir);

	return true;
}

/**
 * Install a Theme and optionally activate
 **/
export async function installTheme(url, opts) {

	opts = opts ? opts : {};

	let cmd = 'wp theme install';
	cmd += ' ' + url;
	cmd += ' --color';

	// Should we activate this theme?
	let activate = opts.activate;
	if (!opts.hasOwnProperty('activate')) {
		let activateAnswer = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'confirm',
				message: 'Would you like to activate this theme as well?',
				default: true
			}
		]);
		if (activateAnswer.confirm) {
			activate = true;
		}
	}
	if (activate) {
		cmd += ' --activate';
	}

	sh.exec(cmd);
}

/**
 * Check whether WordPress Core is installed
 **/
export async function isInstalled() {
	let isInstalled = env.getCurrent().wpCli(['core', 'is-installed']).code;
	return (isInstalled === 0);
}
