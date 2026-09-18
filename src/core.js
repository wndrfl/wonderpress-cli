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
 * The wonderpress-core tag this CLI scaffolds with.
 *
 * Bumped deliberately alongside a core release, never floated. The pair is the
 * version contract between the two repos until core becomes a real Composer
 * package (ROADMAP Phase 1).
 */
export const CORE_VERSION = 'v1.3.0';

/**
 * Where wonderpress-core is installed from, and at what ref.
 *
 * Pinned by default — see CORE_VERSION. Both halves can be overridden from the
 * environment, which exists for one reason: testing an unreleased core without
 * tagging one. Before this, the only way to try a core change through `init` was
 * to cut a tag for it, which turns every experiment into a release.
 *
 *   WONDERPRESS_CORE_REPO=../wonderpress-core   a local checkout, or any remote
 *   WONDERPRESS_CORE_REF=my-branch              any tag, branch or commit
 *
 * An override warns every time and is recorded as what it actually is, so a
 * project built from a branch never claims to be running a released version.
 * Reproducibility is the whole point of the pin, and a silent override would
 * hand it back.
 **/
export function resolveCoreSource() {

  const repo = process.env.WONDERPRESS_CORE_REPO || CORE_REPO;
  const ref = process.env.WONDERPRESS_CORE_REF || CORE_VERSION;

  if (repo !== CORE_REPO || ref !== CORE_VERSION) {
    log.warn(`Installing wonderpress-core from ${repo} @ ${ref} instead of the pinned ${CORE_VERSION}.`);
    log.warn(`This project will NOT be reproducible. Unset WONDERPRESS_CORE_REPO / WONDERPRESS_CORE_REF for a real build.`);
  }

  return { repo, ref };
}

/**
 * The canonical home of wonderpress-core.
 **/
export const CORE_REPO = 'https://github.com/wndrfl/wonderpress-core.git';

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
      // Tear the environment down BEFORE deleting the directory it lives in.
      // wp-env derives an environment's identity from the path it was started
      // in, so a directory removed first leaves its containers and volumes with
      // nothing to name them by — running, holding the port, and invisible to
      // every later `wp-env destroy`. Deleting the files is the easy half.
      if (fs.existsSync(targetDir)) {
        const saveCwd = process.cwd();
        process.chdir(targetDir);
        await teardown(backend, initConfig);
        process.chdir(saveCwd);
      }

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
    namespace: resolveProjectNamespace(process.cwd(), initConfig),
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
  // Pinned, not tracked. wonderpress-core is central IP and a moving branch
  // would mean two projects scaffolded a fortnight apart silently get different
  // code — with no way to say which one a client site runs, or to upgrade it on
  // purpose. The version is recorded below so the site can answer that question
  // without anyone reading its git history.
  const coreSource = resolveCoreSource();
  const coreInstalled = await wordpress.installMuPlugin(coreSource.repo, coreSource.ref);

  if (!coreInstalled) {
    return false;
  }

  // Recorded only now, unlike the backend above: the backend is worth knowing
  // even when a provision failed halfway, but a core version is a claim about
  // what is on disk, and claiming one we failed to install would be worse than
  // recording nothing.
  // The ref that was ACTUALLY installed, not the one we would have preferred.
  // A project built from a branch should say so when someone later asks which
  // core it is running.
  config.write(process.cwd(), { core: coreSource.ref });

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

  reportWhereTheSiteIs(backend, initConfig);

  return true;
}

/**
 * Say where the site is, and how to reach it.
 *
 * `init` used to end on "initialized!" and nothing else, which left the one
 * question everybody actually has — what do I open? — unanswered. It mattered
 * most on the backend where there is no next command to infer it from: the host
 * backend at least hands you `wonderpress server`, while wp-env finishes with
 * the site already up at a port only its config knows.
 *
 * Deliberately no password. The admin name is a convenience; echoing a
 * credential into a scrollback buffer is not this command's business.
 **/
function reportWhereTheSiteIs(backend, initConfig) {

  const url = typeof backend.siteUrl === 'function' ? backend.siteUrl(initConfig) : null;

  if (!url) {
    return;
  }

  // Asked of the backend rather than assumed from the flags: on wp-env the
  // first user is created by `wp-env start`, so nothing the caller passed
  // describes it.
  const login = typeof backend.adminLogin === 'function'
    ? backend.adminLogin(initConfig)
    : { user: (initConfig && initConfig.wp && initConfig.wp.adminUser) || 'admin', password: null, note: null };

  const credentials = [login.user, login.password].filter(Boolean).join(' / ');
  const note = login.note ? `  (${login.note})` : '';

  log.raw('');
  log.raw(`  Site      ${url}`);
  log.raw(`  Admin     ${url}/wp-admin`);
  log.raw(`  Login     ${credentials}${note}`);

  // The two backends differ on whether anything still has to be started, and
  // getting that wrong sends someone to a dead port.
  log.raw(backend.capabilities && backend.capabilities.detachedServer
    ? `  Serving   already — this backend keeps running in the background`
    : `  Serving   not yet — run \`wonderpress server\``);
  log.raw('');
}

/**
 * The namespace to record, for a project that may already have one.
 *
 * `init` is not only run on empty directories — it rebuilds, it repairs, and
 * after `destroy` it is how a project comes back. Writing the namespace
 * unconditionally meant every one of those silently reset it to the default,
 * and blocks created afterwards landed in a different namespace than the blocks
 * already on the client's pages. That is the split-namespace failure the whole
 * precedence rule exists to prevent, arrived at through the one command nobody
 * thought of as re-namespacing anything.
 *
 * An existing namespace therefore wins over the default. Only an explicit
 * --namespace overrides it, and even then it says what it is doing, because
 * content already placed does not move with it.
 **/
function resolveProjectNamespace(root, initConfig) {

  const existing = config.read(root).data.namespace;
  const requested = initConfig && initConfig.namespace;

  if (isValidNamespace(requested)) {
    if (isValidNamespace(existing) && existing !== requested) {
      log.warn(`This project's blocks are namespaced \`${existing}\`, and --namespace asks for \`${requested}\`.`);
      log.warn(`Blocks already placed on pages stay \`${existing}\` and will stop resolving. Only do this before a site has content.`);
    }
    return requested;
  }

  if (isValidNamespace(existing)) {
    return existing;
  }

  return LEGACY_NAMESPACE;
}

/**
 * Configuration that belongs to the ENVIRONMENT rather than to the project.
 *
 * Both are generated by `init` and both are backend-specific: wp-config.php
 * names a database that only one backend can reach, and .wp-env.json is enough
 * on its own for backend resolution to detect wp-env.
 *
 * wp-config.php can carry a project's own constants, so removing it is a real
 * cost — but a file that silently prevents a rebuild is worse than one you were
 * told would go, which is why `destroy` names it before doing it.
 *
 * WordPress core is deliberately NOT here: expensive to re-download, and `init`
 * steps over it harmlessly.
 **/
const ENVIRONMENT_FILES = ['wp-config.php', '.wp-env.json'];

/**
 * Tear an environment's services and data down, leaving the files alone.
 *
 * Backends differ in what they own — wp-env holds containers and volumes, the
 * host backend holds a database — so each answers for itself. A backend with
 * nothing to tear down is not an error.
 **/
async function teardown(backend, initConfig) {

  if (typeof backend.destroy !== 'function') {
    log.info(`The ${backend.name} environment has nothing to tear down.`);
    return true;
  }

  return reportBackendStep(await backend.destroy(initConfig));
}

/**
 * `wonderpress destroy` — remove the environment, keep the code.
 *
 * Deliberately does NOT delete files. The theme, the partials and the manifests
 * are the work; the database and the containers are the scaffolding around it.
 * Conflating the two is how someone loses an afternoon to a command they
 * expected to free a port.
 **/
export async function destroy(args = {}) {

  if (! await setCwdToEnvironmentRoot()) {
    return false;
  }

  const backend = env.getCurrent();
  const root = process.cwd();

  // The environment's generated configuration, as opposed to the work. Leaving
  // it behind is what made a torn-down project rebuildable only as the backend
  // it already was: wp-config.php still names the old backend's database, and a
  // leftover .wp-env.json makes backend resolution DETECT wp-env regardless of
  // what anyone asks for.
  const generated = ENVIRONMENT_FILES.filter((file) => fs.existsSync(path.join(root, file)));

  if (!args['--yes']) {
    const losing = generated.length ? `\nAlso removed: ${generated.join(', ')}.` : '';

    const answer = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Tear down the ${backend.name} environment in \`${root}\`? The database will be destroyed.${losing}\nYour theme, partials, manifests and uploads are left alone.`,
        default: false,
      }
    ]);

    if (answer.confirm !== true) {
      log.success('Left alone.');
      return true;
    }
  }

  // Services first, config second. A backend identifies its environment through
  // the very files being removed here, so tearing down after deleting them is
  // how containers get orphaned — the same ordering mistake --clean-slate used
  // to make.
  const ok = await teardown(backend, {});

  if (!ok) {
    return false;
  }

  for (const file of generated) {
    fs.removeSync(path.join(root, file));
    log.info(`Removed ${file}`);
  }

  // The recorded backend describes an environment that no longer exists.
  // Clearing it is what lets the next `init` choose freely.
  config.remove(root, 'environment');

  log.success('The environment is gone. Rebuild it with `wonderpress init --env host` or `--env wp-env`.');

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

