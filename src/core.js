const composer = require('./composer');
const config = require('./config');
const fs = require('fs-extra');
const inquirer = require('inquirer');
const log = require('./log');
const readme = require('./readme');
const sh = require('shelljs');
const staticCli = require('@wndrfl/static-kit-cli');
const wordpress = require('./wordpress');

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
  switch(subcommand) {
    case 'init':
      await init(args['--dir'] || null, {
        cleanSlate : args['--clean-slate'] || false
      });
      break;
    case 'version':
      await version({});
      break;
  }

  return true;
}

/**
 * Initialize a new or existing Wonderpress Development Environment
 **/
export async function init(dir, opts) {

  // Check for WP CLI
  if (!sh.which('wp')) {
    log.error(`Wonderpress leans heavily on the WP CLI. Please visit https://wp-cli.org/ and follow installation instructions before trying again.`);
    return 0;
  }

  // Get options
  opts = opts || {};

  // Set the target directory
  const targetDir = dir || process.cwd();

  // DO NOT set process.cwd() to targetDir yet.

  // Clear the entire directory?
  if(opts.cleanSlate) {
    if(targetDir == '.') {
      log.error(`The --clean-slate does not work when initializing into your current directory. Please navigate outside of this directory and try again.`);
      return false;
    }

    const cleanSlateConfirmationAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Hey, this is serious. It will delete *everything* in the directory: \`${targetDir}\`. Are you sure you want to delete *everything* in this directory?`,
        default: false,
      }
    ]);

    if(cleanSlateConfirmationAnswer.confirm === true) {
      log.warn(`Clearing the entire directory (clean slate!)`);
      await sh.exec(`rm -rf ${targetDir}`);
    } else {
      log.success(`You are safe. Cancelling the installation. Please try again without requesting a clean slate installation.`);
      return;
    }
  }

  // Make sure the target directory exists, and
  // change context to it
  await fs.ensureDirSync(targetDir);
  process.chdir(targetDir);

  log.info(`✨ Setting up Wonderpress...`);

  // Check to see if there is already an installation in
  // the target directory. If there is, then don't install.
  if(! await config.exists(process.cwd())) {

    log.info(`Installing Wonderpress Development Environment into ${process.cwd()}`);

    // Clone and prune the Wonderpress Development Environment
    const tmpDir = '.wonderpress-tmp';
    sh.exec('rm -rf ' + tmpDir);
    let cmd = `git clone https://github.com/wndrfl/wonderpress-development-environment.git ${tmpDir} --progress --verbose`;
    sh.exec(cmd);
    sh.exec(`rm -rf ${tmpDir}/.git`);
    sh.exec(`rm -rf ${tmpDir}/.github`);
    sh.exec(`cp -R ${tmpDir}/. ${process.cwd()}`);
    sh.exec(`rm -rf ${tmpDir}`);

    // Install Static Kit
    const saveCwd = process.cwd();
    await staticCli.core.installKit(`./wp-content/themes/wonderpress/static`, {
      compile : true,
      init : true,
      name : '404,archive,author,category,index,page,search,single,tag',
    });
    process.chdir(saveCwd);
  }

  // Download WordPress Core
  await wordpress.downloadWordPress();

  // Configure WordPress Core
  await wordpress.configureWordPress();

  // Install WordPress Core
  await wordpress.installWordPress();

  // Install Composer
  await composer.installComposer();

  // Attempt to activate an existing theme
  log.info(`Checking for themes that can be activated...`);
  const themes = await wordpress.getAllThemes();

  // If there is only 1 theme, then lets activate it
  if(themes.length == 1) {

    log.info(`Activating ${themes[0].name} theme...`);
    wordpress.activateTheme(themes[0].name);

  // If there is more than 1 theme, then we need to have
  // the user select which theme to activate
  } else if(themes.length > 1) {

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
      log.info(`Activating ${themeToActivateAnswer.themeToActivate} theme...`)
      wordpress.activateTheme(themeToActivateAnswer.themeToActivate);
    }
  }

  // Create a Readme?
  if(! await readme.exists(process.cwd())) {
    const createReadmeAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Would you like to create a readme?',
        default: true,
      }
    ]);

    if(createReadmeAnswer.confirm === true) {
      await readme.create();
    }
  }

  log.success(`The Wonderpress environment has been initialized!`);

  return true;
}

/**
 * Get the root directory of the Wonderpress environment.
 **/
export async function getRootDir() {
  let path = process.cwd();
  let seek = true;
  let c = 0;
  while(seek) {
    if(c++ >= 50) break;
    if(! await config.exists(path)) {
      path = `../${path}`;
    } else {
      return path;
    }
  }

  return false;

}

/**
 * Attempt to find the Wonderpress Development Environment root,
 * and change the cwd context to the root if found.
 **/
export async function setCwdToEnvironmentRoot() {

  const path = await getRootDir();

  if(path) {
    process.chdir(path);
    return true;
  }

  log.error(`This does not appear to be a Wonderpress Development Environment.`);
  return false;
}

/**
 * Get the current version.
 **/
export function version() {
  const version = require('../package.json').version;
  log.raw(`Wonderpress CLI ${version}`);
}

