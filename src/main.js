import inquirer from 'inquirer';

Array.prototype.asyncForEach = async function(callback, thisArg) {
  thisArg = thisArg || this
  for (let i = 0, l = this.length; i !== l; ++i) {
    await callback.call(thisArg, this[i], i, this)
  }
}

const fs = require("fs");
const mysql = require('mysql2/promise');
const pathToThemesDir = './wp-content/themes';
const shelljs = require('shelljs');
const sqlString = require('sqlstring');


export async function configureWordPress() {

	// Set up the mysql connection
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

		connection = await mysql.createConnection({
			host     : configAnswers.dbHost,
			user     : configAnswers.dbUser,
			password : configAnswers.dbPassword
		})
		.catch(() => {
			console.log('The hostname / username / password combination you entered wasn\'t correct. Try again?');
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
									console.log('The database `' + databaseAnswers.dbName + '` was created!');
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

	// Close the connection
	await connection.end()
			.catch((err) => {
				console.warn(err)
			});
	
	// Use WP CLI to create the wp-config.php file
	let wpConfigCreateCmd 	= 'wp config create';
	wpConfigCreateCmd 		+= ' --dbhost=' + configAnswers.dbHost;
	wpConfigCreateCmd 		+= ' --dbuser=' + configAnswers.dbUser;
	wpConfigCreateCmd 		+= ' --dbpass=' + configAnswers.dbPassword;
	wpConfigCreateCmd 		+= ' --dbname=' + databaseAnswers.dbName;
	wpConfigCreateCmd 		+= ' --force';
	shelljs.exec(wpConfigCreateCmd);

	return true;
}

export async function createThemesDirectory() {
	shelljs.mkdir('-p', pathToThemesDir);
	return true;
}

export async function downloadWordPress() {
	shelljs.exec('wp core download --skip-content --force');
	return true;
}

export async function installBebopTheme(localName) {
	localName = localName || 'bebop';

	let repo = 'https://github.com/wndrfl/bebop.git';
	await installTheme(repo, localName);
	return true;
}

export async function installComposer() {
	if (await !fs.existsSync('./vendor')) {
		console.log('Installing Composer packages...');
		shelljs.exec('composer install');
	}

	return true;
}

export async function installTheme(repo, localName) {

	await createThemesDirectory();

	// What should we name the theme?
	if(!localName) {
		let answer = await inquirer.prompt([
			{
				type: 'input',
				name: 'localName',
				message: 'What would you like to name this theme?',
				filter: function(input) {

					const a = 'àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìłḿñńǹňôöòóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż·/_,:;'
					const b = 'aaaaaaaaaacccddeeeeeeeegghiiiiiilmnnnnoooooooooprrsssssttuuuuuuuuuwxyyzzz------'
					const p = new RegExp(a.split('').join('|'), 'g')

					return string.toString().toLowerCase()
						.replace(/\s+/g, '-') // Replace spaces with -
						.replace(p, c => b.charAt(a.indexOf(c))) // Replace special characters
						.replace(/&/g, '-and-') // Replace & with 'and'
						.replace(/[^\w\-]+/g, '') // Remove all non-word characters
						.replace(/\-\-+/g, '-') // Replace multiple - with single -
						.replace(/^-+/, '') // Trim - from start of text
						.replace(/-+$/, '') // Trim - from end of text
				},
				validate: function(input) {
					return input !== '';
				}
			}
		]);

		localName = answer.localName;
	}

	// Make path to themes dir
	let path = pathToThemesDir + '/' + localName;
	if (fs.existsSync(path)) {
		let overwriteThemeAnswer = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'confirm',
				message: 'This theme already exists. Do you want to overwrite it?',
				default: false
			}
		]);
		if(!overwriteThemeAnswer.confirm) {
			return false;
		}else{
			shelljs.exec('rm -rf ' + path);
		}
	}

	// Clone repo into themes directory
	let cmd = 'git clone';
	cmd		+= ' ' + repo;
	cmd		+= ' ' + path;
	shelljs.exec(cmd);

	return true;
}

export async function installWonderPress() {
	let cmd = 'git clone https://github.com/wndrfl/wonderpress.git .tmp';
	shelljs.exec(cmd);
	shelljs.exec('rm -rf .tmp/.git && cp -rpv .tmp/ . && rm -rf .tmp');
}

export async function installWordPress() {

	// Ask questions about installation parameters
	let installAnswers = await inquirer.prompt([
		{
			type: 'input',
			name: 'url',
			message: 'What is the url you would like to use for development?',
			validate: function(input) {
				return input !== '';
			}
		},
		{
			type: 'input',
			name: 'title',
			message: 'What is the title of the site?',
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
	shelljs.exec(wpInstallCmd);

	return true;
}


export async function installWPCLI() {
	// Install `wp-cli` latest release
	if (!shelljs.which('wp')) {
		console.log('Downloading and installing WP CLI');
		shelljs.exec('curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar');
		shelljs.exec('mv wp-cli.phar wp-cli');
	}

	return true;
}

export async function lintTheme(name) {

	await installComposer();

	await createThemesDirectory();

	let dirs = await fs.readdirSync(pathToThemesDir, { withFileTypes: true })
	    .filter(dirent => dirent.isDirectory())
	    .map(dirent => dirent.name);

	if(!name) {
		let answer = await inquirer.prompt([
			{
				type: 'list',
				name: 'name',
				message: 'Which theme would you like to lint?',
				choices: dirs,
				validate: function(input) {
					return input !== '';
				}
			}
		]);

		name = answer.name;
	}

	let path = pathToThemesDir + '/' + name;

	let cmd = './vendor/bin/phpcs';
	cmd		+= ' ' + path;
	cmd		+= ' -p -v --colors --standard=WordPress-Core --ignore=*/node_modules/*,*/css/*,*/js/*';
	shelljs.exec(cmd);

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
		fixCmd		+= ' -p -v --colors --standard=WordPress-Core --ignore=*/node_modules/*,*/css/*,*/js/*';
		shelljs.exec(fixCmd);
	}

	return true;
}


export async function setup() {

	console.log('Setting up WonderPress...');

	await installWPCLI();
	await downloadWordPress();
	await installWonderPress();
	await configureWordPress();
	await installWordPress();
	await installComposer();

	let installBebopAnswer = await inquirer.prompt([
		{
			type: 'confirm',
			name: 'confirm',
			message: 'Would you like to install the Bebop WordPress Theme?',
			default: false
		}
	]);
	if(installBebopAnswer.confirm) {
		await installBebopTheme();
	}
}

export async function upgradeWonderPress() {
	await installWonderPress();
}