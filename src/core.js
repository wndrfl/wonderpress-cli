import * as composer from './composer.js';
import * as config from './config.js';
import * as env from './env/index.js';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import * as log from './log.js';
import os from 'os';
import path from 'path';
import * as readme from './readme.js';
import sh from 'shelljs';
import * as staticCli from '@wndrfl/static-kit-cli';
import * as wordpress from './wordpress.js';
import { resolveInitConfig } from './init-config.js';
import { isValidNamespace, LEGACY_NAMESPACE } from './validate.js';
import pkg from '../package.json' with { type: 'json' };

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
  switch (subcommand) {
    case 'init':
      await init(args['--dir'] || null, resolveInitConfig(args, process.env));
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
export async function init(dir, initConfig) {

  // Whatever the backend needs before we write anything to disk. Failing here
  // costs 200ms; failing after the scaffold clone and npm install costs
  // minutes.
  const backend = env.getCurrent();
  const preflight = await backend.preflight();
  if (!preflight.ok) {
    preflight.errors.forEach((error) => log.error(error));
    // Exit non-zero. This used to `return 0`, so an init that refused to run
    // for want of WP-CLI still told the shell it had succeeded.
    process.exitCode = 1;
    return false;
  }

  initConfig = initConfig || {};
  const interactive = initConfig.interactive !== false;

  // Set the target directory
  const targetDir = dir || process.cwd();

  // DO NOT set process.cwd() to targetDir yet.

  // Clear the entire directory?
  if (initConfig.cleanSlate) {
    if (targetDir == '.') {
      log.error(`The --clean-slate does not work when initializing into your current directory. Please navigate outside of this directory and try again.`);
      return false;
    }

    // Destructive: prompt when interactive; a headless run only reaches here
    // because --yes was passed, so proceed.
    let doWipe = !interactive;
    if (interactive) {
      const cleanSlateConfirmationAnswer = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Hey, this is serious. It will delete *everything* in the directory: \`${targetDir}\`. Are you sure you want to delete *everything* in this directory?`,
          default: false,
        }
      ]);
      doWipe = cleanSlateConfirmationAnswer.confirm === true;
    }

    if (doWipe) {
      log.warn(`Clearing the entire directory (clean slate!)`);
      await sh.exec(`rm -rf ${targetDir}/*`);
      await sh.exec(`rm -rf ${targetDir}/.*`);
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
  if (! await config.exists(process.cwd())) {

    log.info(`Installing Wonderpress Development Environment into ${process.cwd()}`);

    // Clone and prune the Wonderpress Development Environment
    const tmpDir = '.wonderpress-tmp';
    await fs.emptyDirSync(tmpDir);

    let cmd = `git clone https://github.com/wndrfl/wonderpress-development-environment.git ${tmpDir} --depth=1 --progress --verbose`;
    sh.exec(cmd);

    // Copy a filtered list of files
    await fs.copySync(tmpDir, process.cwd(), {
      filter: (src, dest) => {
        // Ignore specific files
        const basename = src.split(/[\\/]/).pop();
        return ![
          '.git',
          '.github'
        ].includes(basename);
      }
    });
    await fs.removeSync(tmpDir);

    // Install Static Kit
    const saveCwd = process.cwd();
    await staticCli.core.installKit(`./wp-content/themes/wonderpress/static`, {
      compile: true,
      init: true,
      name: '404,archive,author,category,index,page,search,single,tag',
    });
    process.chdir(saveCwd);
  }

  // Record which backend built this environment, as soon as there is a root to
  // record it in — not at the end. A provision that fails halfway must still be
  // discoverable as the kind of environment it is, or the next command resolves
  // the wrong backend and does something incoherent.
  //
  // The block namespace is pinned at the same moment and for a stronger
  // reason: it is written into the client's content as `<!-- wp:acme/hero -->`,
  // so it must be decided once and never drift. Recording it here means a
  // later theme rename cannot silently re-namespace content already placed.
  config.write(process.cwd(), {
    environment: { backend: backend.name },
    namespace: isValidNamespace(initConfig.namespace) ? initConfig.namespace : LEGACY_NAMESPACE,
  });

  // Anything the backend needs on disk before it can provision.
  const prepared = await backend.prepare(initConfig);
  if (! reportBackendStep(prepared)) {
    return false;
  }

  // Download, configure and install WordPress. The backend owns the order:
  // the host downloads then configures then installs, where a container-based
  // backend provisions along a different graph entirely.
  //
  // Stop here on failure rather than carrying on. An environment with no
  // database is not an environment: the remaining steps would install the
  // mu-plugin and Composer packages into it, fail again at theme activation,
  // and then print "The Wonderpress environment has been initialized!"
  const provisioned = await backend.provision(initConfig);
  if (! reportBackendStep(provisioned)) {
    return false;
  }

  // Install the Wonderpress Core as an MU (must use) plugin
  await wordpress.installMuPlugin('https://github.com/wndrfl/wonderpress-core.git');

  // Install Composer
  await composer.installComposer();

  // Activate a theme. --theme wins; otherwise auto-activate a lone theme, and
  // prompt (interactive) or error (headless) when several exist.
  log.info(`Checking for themes that can be activated...`);
  if (initConfig.theme) {
    log.info(`Activating ${initConfig.theme} theme...`);
    wordpress.activateTheme(initConfig.theme);
  } else {
    const themes = await wordpress.getAllThemes();

    if (themes.length == 1) {
      log.info(`Activating ${themes[0].name} theme...`);
      wordpress.activateTheme(themes[0].name);
    } else if (themes.length > 1) {
      if (interactive) {
        const choices = themes.map((theme) => ({ name: theme.name, value: theme.name }));
        const themeToActivateAnswer = await inquirer.prompt([
          {
            type: 'list',
            name: 'themeToActivate',
            message: 'Which theme would you like to activate?',
            choices: choices,
          }
        ]);
        if (themeToActivateAnswer.themeToActivate) {
          log.info(`Activating ${themeToActivateAnswer.themeToActivate} theme...`);
          wordpress.activateTheme(themeToActivateAnswer.themeToActivate);
        }
      } else {
        log.error('Multiple themes found. Pass --theme <name> to choose which to activate.');
      }
    }
  }

  // Create a Readme?
  if (! await readme.exists(process.cwd())) {
    if (interactive) {
      if (!initConfig.skipReadme) {
        const createReadmeAnswer = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirm',
            message: 'Would you like to create a readme?',
            default: true,
          }
        ]);
        if (createReadmeAnswer.confirm === true) {
          await readme.create();
        }
      }
    } else if (initConfig.readme) {
      // Headless: generate a README named after the site title.
      await readme.create({ '--project-name': (initConfig.wp && initConfig.wp.title) || undefined });
    }
  }

  log.success(`The Wonderpress environment has been initialized!`);

  return true;
}

/**
 * Log a backend lifecycle step's errors and flag the process as failed.
 *
 * Returns whether the step succeeded, so callers can stop. A step that returns
 * nothing counts as success — backends are free to leave a lifecycle hook
 * as a no-op.
 **/
function reportBackendStep(result) {

  if (!result || result.ok !== false) {
    return true;
  }

  (result.errors || []).forEach((error) => log.error(error));
  process.exitCode = 1;

  return false;
}

/**
 * Get the root directory of the Wonderpress environment.
 *
 * Walks up from `startDir` (default: cwd) looking for the marker
 * `config.exists()` recognises, and returns the first directory that has one.
 *
 * The walk used to build `../${path}` from an absolute path, which produced a
 * nonexistent directory on every iteration — so it only ever succeeded when
 * cwd was already the root, and otherwise spun 50 times and gave up. Commands
 * run from a subdirectory (`server start` from inside the theme, say) reported
 * "This does not appear to be a Wonderpress Development Environment."
 *
 * $HOME is deliberately never returned. `rc` conventions actively invite a
 * `~/.wonderpressrc`, and with a working walk one would make every directory
 * under the home dir look like an environment root — which would point `lint`
 * at $HOME and run phpcs against it. `opts.home` overrides which directory
 * that is, so a test can cover the rule without writing into a real one.
 **/
export async function getRootDir(startDir, opts) {

  const home = (opts && opts.home) || os.homedir();
  let dir = path.resolve(startDir || process.cwd());

  for (;;) {
    if (dir !== home && await config.exists(dir)) {
      return dir;
    }

    // path.dirname is a fixpoint at the filesystem root ('/', or 'C:\'), which
    // is the termination condition — no iteration cap needed.
    const parent = path.dirname(dir);
    if (parent === dir) {
      return false;
    }

    dir = parent;
  }
}

/**
 * Attempt to find the Wonderpress Development Environment root,
 * and change the cwd context to the root if found.
 **/
export async function setCwdToEnvironmentRoot() {

  const path = await getRootDir();

  if (path) {
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
  log.raw(`Wonderpress CLI ${pkg.version}`);
}

