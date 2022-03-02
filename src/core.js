import fs from 'fs';
import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const readme = require('./readme');
const wonderpressConfigPath = './wonderpress.json';
const wordpress = require('./wordpress');

const open = require('open');
const sh = require('shelljs');

export async function command(subcommand, args) {
  switch(subcommand) {
    case 'init':
      await init(args);
      break;
  }

  return true;
}


export async function bootstrapThemes() {

  log.info(`Searching for existing themes for bootstrapping...`);

  const themePaths = [];

  await fs.readdirSync(wordpress.pathToThemesDir).filter(function (path) {
    const themePath = wordpress.pathToThemesDir+'/'+path;
    if(fs.statSync(themePath).isDirectory()) {
      themePaths.push(themePath);
    }
  })

  if(themePaths.length < 1) {
    log.info(`No themes were found for bootstrapping. Skipping...`);
    return;
  }

  themePaths.forEach((themePath) => {
    log.info(`Bootstrapping theme: ${themePath}`);
    sh.exec(`npm install --prefix ${themePath}`);
    sh.exec(`composer install --working-dir=${themePath}`);
    log.info(`Bootstrapping is complete.`);
  });
}

export async function getWonderpressConfig() {
  if(await fs.existsSync(wonderpressConfigPath)) {
    const configRaw = fs.readFileSync(wonderpressConfigPath);
    const configJson = JSON.parse(configRaw);
    return configJson;
  }

  log.info(`No configuration file found at: ${wonderpressConfigPath}`);

  return false;
}

export async function installWonderpressTheme(opts) {
  log.info(`Installing Wonderpress Theme...`);

  if(!await wordpress.isInstalled()) {
    log.error(`WordPress is not installed. Please setup your Wonderpress Development Environment first.`);
    return false;
  }

  let url = 'https://github.com/wndrfl/wonderpress-theme/archive/master.zip';
  await wordpress.installTheme(url, opts);
  sh.exec(`npm --prefix ${wordpress.pathToThemesDir}/wonderpress-theme run init`);
  return true;
}

export async function installWonderpressDevelopmentEnvironment(dir) {

  const targetDir = (dir) ? dir : '.';

  log.info(`Installing Wonderpress Development Environment into ${targetDir}`);

  if(await getWonderpressConfig()) {
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
      log.info(`Skipping Wonderpress Development Environment installation...`);
      return;
    }
  }

  const tmpDir = '.wonderpress-tmp';
  sh.exec('rm -rf ' + tmpDir);
  let cmd = `git clone https://github.com/wndrfl/wonderpress-development-environment.git ${tmpDir} --progress --verbose`;
  sh.exec(cmd);
  sh.exec(`rm -rf ${tmpDir}/.git`);
  sh.exec(`rm -rf ${tmpDir}/.github`);
  sh.exec(`cp -R ${tmpDir}/. ${targetDir}`);
  sh.exec(`rm -rf ${tmpDir}`);
}

export async function installWPCLI() {
  // Install `wp-cli` latest release
  if (!sh.which('wp')) {
    log.info(`Downloading and installing WP CLI`);
    sh.exec(`curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar`);
    sh.exec(`mv wp-cli.phar wp-cli`);
  }

  return true;
}

export async function init(args) {

  const targetDir = args['--dir'] ? args['--dir'] : '.';
  if(!await fs.existsSync(targetDir)) {
    const mkdirResult = await fs.mkdir(targetDir, (err) => {
      if(err) {
        log.info(err);
      }
    });
  }
  process.chdir(targetDir);

  // Clear the entire directory?
  if(args['--clean-slate']) {
    const cleanSlateConfirmationAnswer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Hey, this is serious. It will delete *everything* in your current directory. Please note your current directory. Are you sure you want to delete *everything* in your current directory?',
        default: false,
      }
    ]);

    if(cleanSlateConfirmationAnswer.confirm === true) {
      console.log(`🚨 Clearing the entire directory (clean slate!)`);
      require('child_process').execSync(`rm -rf ./* && rm -rf .*`);
    } else {
      console.log(`You are safe. Cancelling the installation. Please try again without requesting a clean slate installation.`);
      return;
    }
  }

  log.info(`✨ Setting up Wonderpress...`);

  await installWPCLI();
  await installWonderpressDevelopmentEnvironment();
  await wordpress.downloadWordPress();
  await wordpress.configureWordPress();
  await wordpress.installWordPress();
  await composer.installComposer();

  // Initialize any existing themes found in wonderpress.json
  await bootstrapThemes();

  // Attempt to activate an existing theme, or install Wonderpress Theme
  log.info(`Checking for themes that can be activated...`);

  const themes = await wordpress.getAllThemes();

  if(themes.length > 0) {

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

    log.info(`No existing themes for activation detected...`);

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
    await readme.create();
  }


  log.success(`The Wonderpress environment has been initialized!`);

  return true;
}

export async function isWonderpressRoot() {
  const config = await getWonderpressConfig();
  return (config) ? true : false;
}

export async function setCwdToEnvironmentRoot() {
  let path = process.cwd();
  let seek = true;
  let c = 0;
  while(seek) {
    if(c++ >= 50) break;
    const checkPath = `${path}/${wonderpressConfigPath}`;
    if(!await fs.existsSync(checkPath)) {
      process.chdir('../');
      path = process.cwd();
    } else {
      return path;
    }
  }

  log.error(`This does not appear to be a Wonderpress Development Environment.`);
}

