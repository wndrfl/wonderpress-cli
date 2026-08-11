import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';
import sh from 'shelljs';
import * as config from './config.js';
import * as core from './core.js';
import inquirer from 'inquirer';
import mysql2 from 'mysql2/promise';
import rc from 'rc';
import sqlString from 'sqlstring';

// Common paths
export const pathToThemesDir = './wp-content/themes';
export const pathToMuPluginsDir = './wp-content/mu-plugins';

/**
 * Activate a specific theme.
 **/
export async function activateTheme(themeName) {
	log.info('Attempting to activate theme: ' + themeName);
	sh.exec('wp theme activate ' + themeName);
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
		return true;
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
export async function getActiveTheme() {

	log.info('Grabbing the currently active theme...');

	if (! await this.isInstalled()) {
		log.error('WordPress is not installed. Please install WordPress, first.');
		return false;
	}

	let themes = JSON.parse(sh.exec('wp theme list --status=active --format=json', { silent: true }));

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
		let themes = JSON.parse(sh.exec('wp theme list --format=json', { silent: true }));
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
 * Install an MU (Must Use) Plugin
 **/
export async function installMuPlugin(url) {

	log.info(`Installing MU Plugin: ${url}...`);

	await fs.ensureDirSync(pathToMuPluginsDir);

	const tmpDir = '.wonderpress-tmp';
	await fs.emptyDirSync(tmpDir);

	const cmd = `git clone ${url} ${tmpDir} --depth=1 --progress --verbose`;
	sh.exec(cmd);

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
	let isInstalled = await sh.exec('wp core is-installed').code;
	return (isInstalled === 0);
}
