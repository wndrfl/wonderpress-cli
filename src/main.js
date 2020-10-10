import inquirer from 'inquirer';

const log = require('./log');

const fs = require('fs');
const mysql2 = require('mysql2/promise');
const open = require('open');
const pathToThemesDir = './wp-content/themes';
const sh = require('shelljs');
const sqlString = require('sqlstring');



export async function configureWordPress() {

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

export async function createThemesDirectory() {
	sh.mkdir('-p', pathToThemesDir);
	return true;
}

export async function downloadWordPress() {
	sh.exec('wp core download --skip-content --force');
	return true;
}

export async function getActiveTheme() {

	log.info('Grabbing the currently active theme...');

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

export async function installWonderpressTheme(opts) {
	let url = 'https://github.com/wndrfl/wonderpress-theme/archive/master.zip';
	await installTheme(url, opts);
	sh.exec('npm install --prefix ' + pathToThemesDir + '/wonderpress-theme');
	return true;
}

export async function installComposer() {
	if (await !fs.existsSync('./vendor')) {
		log.info('Installing Composer packages...');
		sh.exec('composer install');
	}

	return true;
}

export async function installTheme(url, opts) {

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

export async function installWonderpressDevelopmentEnvironment() {
	let cmd = 'git clone https://github.com/wndrfl/wonderpress-development-environment.git .tmp --progress --verbose';
	sh.exec(cmd);
	sh.exec('rm -rf .tmp/.git && cp -rp .tmp/ . && rm -rf .tmp');
}

export async function installWordPress() {

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


export async function installWPCLI() {
	// Install `wp-cli` latest release
	if (!sh.which('wp')) {
		log.info('Downloading and installing WP CLI');
		sh.exec('curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar');
		sh.exec('mv wp-cli.phar wp-cli');
	}

	return true;
}

export async function lintTheme(name) {

	await installComposer();

	await createThemesDirectory();

	if(!name) {
		let theme = await getActiveTheme();
		name = theme.name;
	}

	let path = pathToThemesDir + '/' + name;

	let cmd = './vendor/bin/phpcs';
	cmd		+= ' ' + path;
	cmd		+= ' -p -v --colors';
	sh.exec(cmd);

	let fixAnswer = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'confirm',
			message: 'Would you like to automatically fix as many of these as possible?',
			default: false
		}
	]);
	if(fixAnswer.confirm) {
		let fixCmd = './vendor/bin/phpcbf';
		fixCmd 		+= ' ' + path;
		fixCmd		+= ' -p -v --colors';
		sh.exec(fixCmd);
	}

	return true;
}


export async function setup() {

	log.info('✨ Setting up Wonderpress...');

	await installWPCLI();
	await downloadWordPress();
	await installWonderpressDevelopmentEnvironment();
	await configureWordPress();
	await installWordPress();
	await installComposer();

	let installWonderpressThemeAnswer = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'confirm',
			message: 'Would you like to install the Wonderpress WordPress Theme?',
			default: true
		}
	]);
	if(installWonderpressThemeAnswer.confirm) {
		await installWonderpressTheme({
			activate: true
		});
	}

	log.success('All done.');

	return true;
}

export async function startServer() {
	getActiveTheme();
	log.info('Starting development server...');
	// open('http://localhost:8080');
	sh.exec('wp server');
}
