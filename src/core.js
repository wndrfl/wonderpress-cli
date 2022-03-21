import fs from 'fs';
import inquirer from 'inquirer';

const composer = require('./composer');
const log = require('./log');
const readme = require('./readme');
const wonderpressConfigPath = './.wonderpress';
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

export async function getWonderpressConfig() {
  if(await fs.existsSync(wonderpressConfigPath)) {
    const configRaw = fs.readFileSync(wonderpressConfigPath);
    const configJson = JSON.parse(configRaw);
    return configJson;
  }

  log.info(`No configuration file found at: ${wonderpressConfigPath}`);

  return false;
}

export async function installWonderpressDevelopmentEnvironment(dir) {

  const targetDir = (dir) ? dir : '.';

  if(await getWonderpressConfig()) {
    log.info(`This appears to be an existing Wonderpress Development Environment. We will skip installation and proceed with initialization.`)
    return true;
  }

  log.info(`Installing Wonderpress Development Environment into ${targetDir}`);

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

  // Clear the entire directory?
  if(args['--clean-slate']) {
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

  if(!await fs.existsSync(targetDir)) {
    const mkdirResult = await fs.mkdir(targetDir, (err) => {
      if(err) {
        log.info(err);
      }
    });
  }
  process.chdir(`./${targetDir}`);

  log.info(`✨ Setting up Wonderpress...`);

  await installWPCLI();
  await installWonderpressDevelopmentEnvironment();
  await wordpress.downloadWordPress();
  await wordpress.configureWordPress();
  await wordpress.installWordPress();
  await composer.installComposer();

  // Attempt to activate an existing theme, or install Wonderpress Theme
  log.info(`Checking for themes that can be activated...`);

  const themes = await wordpress.getAllThemes();

  if(themes.length == 1) {

    log.info(`Activating ${themes[0].name} theme...`);
    sh.exec(`npm --prefix ${wordpress.pathToThemesDir}/${themes[0].name} install`);
    wordpress.activateTheme(themes[0].name);

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
  if(! await readme.exists()) {
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

