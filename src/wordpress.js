import inquirer from 'inquirer';

const log = require('./log');
const mysql2 = require('mysql2/promise');
const sh = require('shelljs');

const pathToThemesDir = './wp-content/themes';
exports.pathToThemesDir = pathToThemesDir;

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