import fs from 'fs';
import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const readme = require('./readme');
const wordpress = require('./wordpress');

const open = require('open');
const sh = require('shelljs');

export async function installWonderpressTheme(opts) {
	log.info('Installing Wonderpress Theme...');

	if(!await wordpress.isInstalled()) {
		log.error('WordPress is not installed. Please setup your Wonderpress Development Environment first.');
		return false;
	}

	let url = 'https://github.com/wndrfl/wonderpress-theme/archive/master.zip';
	await wordpress.installTheme(url, opts);
	sh.exec('npm install --prefix ' + wordpress.pathToThemesDir + '/wonderpress-theme');
	return true;
}

export async function installWonderpressDevelopmentEnvironment() {
	log.info('Installing Wonderpress Development Environment...');

	if(fs.existsSync('wonderpress.json')) {
		// Overwrite?
	    const installWonderpressAnswer = await inquirer.prompt([
	      {
	        type: 'confirm',
	        name: 'confirm',
	        message: 'Existing Wonderpress Development Environment detected. Would you like to overwrite it?',
	        default: false,
	      }
	    ]);
	    if(installWonderpressAnswer.confirm !== true) {
	    	log.info('Skipping Wonderpress Development Environment installation...');
			return;
	    }
	}

	const tmpDir = '.wonderpress-tmp';
	sh.exec('rm -rf ' + tmpDir);
	let cmd = 'git clone https://github.com/wndrfl/wonderpress-development-environment.git ' + tmpDir + ' --progress --verbose';
	sh.exec(cmd);
	sh.exec('rm -rf ' + tmpDir + '/.git');
	sh.exec('rm -rf ' + tmpDir + '/.github');
	sh.exec('cp -R ' + tmpDir + '/. .');
	sh.exec('rm -rf ' + tmpDir);
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

export async function setup() {

	log.info('✨ Setting up Wonderpress...');

	await installWPCLI();
	await installWonderpressDevelopmentEnvironment();
	await wordpress.downloadWordPress();
	await wordpress.configureWordPress();
	await wordpress.installWordPress();
	await composer.installComposer();


    // Check for other themes
    log.info('Checking for existing themes...');
    const themes = await wordpress.getAllThemes();
    if(themes.length > 0) {
    	log.info('Existing themes have been detected...');

    	const choices = [];
    	themes.forEach((theme) => {
    		choices.push({
    			'name' : theme.name,
    			'value' : theme.name
    		});
    	});

		// Which theme to activate?
	    const themeToActivateAnswer = await inquirer.prompt([
	      {
	        type: 'list',
	        name: 'themeToActivate',
	        message: 'Which theme would you like to activate?',
	        choices: choices,
	      }
	    ]);
	    if(themeToActivateAnswer.themeToActivate) {
	    	wordpress.activateTheme(themeToActivateAnswer.themeToActivate);
	    }

	// No other themes... try Wonderpress Theme
    } else {

	    log.info('No existing themes detected...');

		// Install Wonderpress Theme?
	    const installWonderpressAnswer = await inquirer.prompt([
	      {
	        type: 'confirm',
	        name: 'confirm',
	        message: 'Would you like to install the default Wonderpress Theme?',
	        default: true,
	      }
	    ]);
	    if(installWonderpressAnswer.confirm === true) {
			await installWonderpressTheme({
				activate: true
			});
	    }
    }

    // Create a Readme?
    const createReadmeAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Would you like to create a readme?',
        default: true,
      }
    ]);
    if(createReadmeAnswer.confirm === true) {
		await readme.createReadme();
    }


	log.success('All done.');

	return true;
}

export async function startServer() {
	log.info('Starting development server...');
	sh.exec('wp server');
}
