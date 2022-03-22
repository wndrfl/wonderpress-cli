const core = require('./core');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const log = require('./log');
const mysql2 = require('mysql2/promise');
const rc = require('rc');
const sh = require('shelljs');
const sqlString = require('sqlstring');

// Common paths
export const pathToThemesDir = './wp-content/themes';
export const pathToMuPluginsDir = './wp-content/mu-plugins';

/**
 * Activate a specific theme.
 **/
export async function activateTheme(theme) {
	log.info('Attempting to activate theme: ' + theme);
	sh.exec('wp theme activate ' + theme);
}

/**
 * Create and setup a wp-config.php
 **/
export async function configureWordPress() {

	if( await this.hasConfig() ) {
    log.info(`A wp-config.php already exists. Skipping WordPress configuration...`);
    return true;
	}

	// Set up the mysql2 connection
	let connection = false;
	while(!connection) {

		var questions = [
			{
				type: 'input',
				name: 'dbHost',
				message: 'What is the database hostname?',
				default: 'localhost',
			},
			{
				type: 'input',
				name: 'dbUser',
				message: 'What is the database username?',
				default: 'root',
				validate: function(input) {
					return input !== '';
				}
			},
			{
				type: 'input',
				name: 'dbPassword',
				message: 'What is the database password?',
				default: ''
			},
		];
		var configAnswers = await inquirer.prompt(questions);

		connection = await mysql2.createConnection({
			host     : configAnswers.dbHost,
			user     : configAnswers.dbUser,
			password : configAnswers.dbPassword
		})
		.catch(() => {
			log.error('The hostname / username / password combination you entered wasn\'t correct. Try again?');
			connection = false;
		});

	}

	// Configure the database
	let validDatabase = false;
	while(!validDatabase) {

		var questions = [
			{
				type: 'input',
				name: 'dbName',
				message: 'What is the database name?',
				default: 'wonderpress'
			}
		];
		var databaseAnswers = await inquirer.prompt(questions);

		await connection.execute("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?", [databaseAnswers.dbName])
				.then( async ([rows,fields]) => {

					if(rows.length) {
						validDatabase = true;
						return true;
					}

					let createAnswer = await inquirer.prompt([
						{
							type: 'confirm',
							name: 'confirm',
							message: 'The database `' + databaseAnswers.dbName + '` doesn\'t exist, would you like to create it?.',
							default: true
						}
					]);
					if(createAnswer.confirm) {
						await connection.execute("CREATE DATABASE " + sqlString.escapeId(databaseAnswers.dbName))
								.then(() => {
									log.success('The database `' + databaseAnswers.dbName + '` was created!');
									validDatabase = true;
								})
								.catch((err) => {
									console.warn(err);
									validDatabase = false;
								});
					}
					
				})
				.catch((err) => {
					console.warn(err);
					validDatabase = false;
				});
	}

	connection.end();
	
	// Use WP CLI to create the wp-config.php file
	let wpConfigCreateCmd 	= 'wp config create';
	wpConfigCreateCmd 		+= ' --dbhost=' + configAnswers.dbHost;
	wpConfigCreateCmd 		+= ' --dbuser=' + configAnswers.dbUser;
	wpConfigCreateCmd 		+= ' --dbpass=' + configAnswers.dbPassword;
	wpConfigCreateCmd 		+= ' --dbname=' + databaseAnswers.dbName;
	sh.exec(wpConfigCreateCmd);

	return true;
}

/**
 * Create the themes directory
 **/
export async function createThemesDirectory() {

	if(! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	if(! await this.isInstalled()) {
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

	if(! await this.isInstalled()) {
		log.error('WordPress is not installed. Please install WordPress, first.');
		return false;
	}

	let themes = JSON.parse(sh.exec('wp theme list --status=active --format=json', { silent: true }));

	if(!themes.length) {
		log.error('There are no active themes.');
		return false;
	}

	if(themes.length > 1) {
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
	} catch(e) {
		return [];
	}
}

/**
 * Check for the existense of a wp-config.php
 **/
export async function hasConfig() {
	const path = sh.exec('wp config path');
	return path.length > 0 ? true : false;
}

/**
 * Install WordPress
 **/
export async function installWordPress() {

	if( await this.isInstalled() ) {
		log.info('WordPress is already installed...');
		return;
	}

	// Ask questions about installation parameters
	let installAnswers = await inquirer.prompt([
		{
			type: 'input',
			name: 'url',
			message: 'What is the url you would like to use for development?',
			default: 'wonderpress.localhost',
			validate: function(input) {
				return input !== '';
			}
		},
		{
			type: 'input',
			name: 'title',
			message: 'What is the title of the site?',
			default: 'wonderpress',
			validate: function(input) {
				return input !== '';
			}
		},
		{
			type: 'input',
			name: 'adminUser',
			message: 'What is the admin username?',
			default: 'admin'
		},
		{
			type: 'input',
			name: 'adminPassword',
			message: 'What is the admin password?',
			default: 'supersecure'
		},
		{
			type: 'input',
			name: 'adminEmail',
			message: 'What is the admin email?',
			default: 'example@example.com'
		},
	]);

	let wpInstallCmd 	= 'wp core install';
	wpInstallCmd 		+= ' --url=' + installAnswers.url;
	wpInstallCmd 		+= ' --title=' + installAnswers.title;
	wpInstallCmd 		+= ' --admin_user=' + installAnswers.adminUser;
	wpInstallCmd 		+= ' --admin_password=' + installAnswers.adminPassword;
	wpInstallCmd 		+= ' --admin_email=' + installAnswers.adminEmail;
	sh.exec(wpInstallCmd);

	return true;
}

/**
 * Install a specific plugin and optionally activate
 **/
export async function installPlugin(url, activate) {
  let cmd = `wp plugin install ${url}`;
  if(activate) {
    cmd += ` --activate`;
  }
  sh.exec(cmd);
}

/**
 * Install an MU (Must Use) Plugin
 **/
export async function installMuPlugin(externalPluginZipUrl) {

  log.info(`Installing MU Plugin: ${externalPluginZipUrl}...`);

  await fs.ensureDirSync(pathToMuPluginsDir);

  const tmpDir = '.wonderpress-tmp';
  await fs.emptyDirSync(tmpDir);

  const cmd = `git clone ${externalPluginZipUrl} ${tmpDir} --depth=1 --progress --verbose`;
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
      if(!wonderpressConfig || !wonderpressConfig.ignore) {
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
	cmd 	+= ' ' + url;
	cmd 	+= ' --color';
	
	// Should we activate this theme?
	let activate = opts.activate;
	if(!opts.hasOwnProperty('activate')) {
		let activateAnswer = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'confirm',
				message: 'Would you like to activate this theme as well?',
				default: true
			}
		]);
		if(activateAnswer.confirm) {
			activate = true;
		}
	}
	if(activate) {
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
