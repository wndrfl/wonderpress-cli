import * as composer from './composer.js';
import * as config from './config.js';
import * as env from './env/index.js';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import * as format from './format.js';
import * as log from './log.js';
import os from 'os';
import path from 'path';
import * as readme from './readme.js';
import { run, runAsync } from './proc.js';
import * as progress from './init-progress.js';
import * as wordpress from './wordpress.js';
import { resolveInitConfig } from './init-config.js';
import { isValidNamespace, LEGACY_NAMESPACE } from './validate.js';
import { importStaticKit, installStaticKit } from './static-kit.js';
import pkg from '../package.json' with { type: 'json' };

/**
 * The Composer package that supplies the Wonderpress runtime.
 *
 * The theme declares the version constraint in its own composer.json — the
 * CLI deliberately does not restate it. One constraint in one place is what
 * makes `composer update` in a project a meaningful, self-contained act rather
 * than something the CLI has to agree to.
 **/
export const CORE_PACKAGE = 'wndrfl/wonderpress-core';

/**
 * The canonical home of wonderpress-core.
 **/
export const CORE_REPO = 'https://github.com/wndrfl/wonderpress-core.git';

/**
 * The canonical home of the environment scaffold.
 **/
export const ENV_REPO = 'https://github.com/wndrfl/wonderpress-development-environment.git';

/**
 * Where the environment scaffold is cloned from, and at what ref.
 *
 * The same escape hatch as WONDERPRESS_CORE_REPO, for the same reason: the
 * scaffold carries the theme, and the theme now carries the composer.json that
 * resolves wonderpress-core. Without this, testing a theme change through
 * `init` means publishing it first.
 *
 *   WONDERPRESS_ENV_REPO=../wonderpress-development-environment
 *   WONDERPRESS_ENV_REF=my-branch
 *
 * Warns whenever either is set, for the same reason the core override does.
 *
 * @returns {{repo: String, ref: String|null}} The scaffold source.
 **/
export function resolveEnvSource() {

  const repo = process.env.WONDERPRESS_ENV_REPO || ENV_REPO;
  const ref = process.env.WONDERPRESS_ENV_REF || null;

  if (repo !== ENV_REPO || ref) {
    log.warn(`Cloning the environment scaffold from ${repo}${ref ? ` @ ${ref}` : ''} instead of the released one.`);
    log.warn(`This project will NOT be reproducible. Unset WONDERPRESS_ENV_REPO / WONDERPRESS_ENV_REF for a real build.`);
  }

  return { repo, ref };
}

/**
 * An override of where wonderpress-core comes from, or null for the default.
 *
 * This exists for one reason: testing an unreleased core without tagging one.
 * Without it, the only way to try a core change through `init` is to cut a tag
 * for it, which turns every experiment into a release.
 *
 *   WONDERPRESS_CORE_REPO=../wonderpress-core   a local checkout, or any remote
 *   WONDERPRESS_CORE_REF=dev-my-branch          any Composer version constraint
 *
 * An override warns every time, so a project built from a branch never quietly
 * claims to be running a released version. Reproducibility is the whole point
 * of the lock file, and a silent override would hand it back.
 **/
export function resolveCoreOverride() {

  const repo = process.env.WONDERPRESS_CORE_REPO || null;
  const ref = process.env.WONDERPRESS_CORE_REF || null;

  if (!repo && !ref) {
    return null;
  }

  log.warn(`Installing ${CORE_PACKAGE} from ${repo || CORE_REPO} @ ${ref || 'the theme\'s own constraint'} instead of the released package.`);
  log.warn(`This project will NOT be reproducible. Unset WONDERPRESS_CORE_REPO / WONDERPRESS_CORE_REF for a real build.`);

  return { repo, ref };
}

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
  switch (subcommand) {
    case 'init':
      await init(args['--dir'] || null, resolveInitConfig(args, process.env));
      break;
    case 'version':
      version(args);
      break;
  }

  return true;
}

/**
 * The theme directories that declare a Composer manifest.
 *
 * Every theme on disk is offered the install, not just the one about to be
 * activated: `init` runs before theme activation, and a project may carry a
 * parent and a child, or a second theme being worked on alongside the first.
 * A theme without a composer.json is skipped by installComposer() itself.
 *
 * @returns {String[]} Paths to theme directories.
 **/
function themeDirsWithManifest() {
  return wordpress.themesOnDisk()
    .map((name) => path.join(wordpress.pathToThemesDir, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'composer.json')));
}

/**
 * Install wonderpress-core into every theme that asks for it.
 *
 * @returns {Promise<Boolean>} True when every theme resolved its dependencies.
 **/
async function installCore() {

  const themeDirs = themeDirsWithManifest();

  if (!themeDirs.length) {
    // Not fatal. A project can legitimately carry a theme that does not depend
    // on core, and failing an otherwise good init over it would be wrong.
    //
    // It is almost never that, though. In practice this means the scaffold that
    // was cloned predates the move of core into the theme, so say so — the bare
    // version of this warning sent people looking in the wrong place.
    log.warn(`No theme declares a composer.json, so ${CORE_PACKAGE} was not installed.`);
    log.warn(`Blocks will not register and partials will run in reduced-functionality mode.`);
    log.warn(`If the theme came from the released scaffold, it predates ${CORE_PACKAGE} moving into the theme.`);
    log.warn(`Point init at a scaffold that has it: WONDERPRESS_ENV_REPO=<path-or-url> WONDERPRESS_ENV_REF=<branch>`);
    return true;
  }

  const override = resolveCoreOverride();

  for (const themeDir of themeDirs) {
    if (override && ! applyCoreOverride(themeDir, override)) {
      return false;
    }

    log.info(`Installing ${CORE_PACKAGE} into ${themeDir}...`);

    if (! await composer.installComposer(themeDir)) {
      return false;
    }
  }

  return true;
}

/**
 * Point a theme at an overridden source for wonderpress-core.
 *
 * Written through `composer config` and `composer require` rather than by
 * editing composer.json here, so Composer validates the result and writes the
 * lock file that goes with it. A local checkout becomes a `path` repository,
 * which Composer symlinks — edits in the checkout show up in the site with no
 * reinstall, which is the whole point of testing an untagged core.
 *
 * @param {String} themeDir The theme to configure.
 * @param {Object} override The result of resolveCoreOverride().
 * @returns {Boolean} True when the override was applied.
 **/
function applyCoreOverride(themeDir, override) {

  const repo = override.repo || CORE_REPO;
  const isLocalPath = fs.existsSync(repo);
  const type = isLocalPath ? 'path' : 'vcs';
  const url = isLocalPath ? path.resolve(repo) : repo;

  // A `path` repository resolves to the checkout's own version, which for an
  // untagged branch is a dev-* constraint that "^2.0" will never match.
  const constraint = override.ref || (isLocalPath ? '*@dev' : 'dev-master');

  const configured = run('composer', ['config', 'repositories.wonderpress-core', type, url], { cwd: themeDir });

  if (configured.code !== 0) {
    log.error(`Could not point ${themeDir} at ${url}.`);
    return false;
  }

  const required = run('composer', ['require', `${CORE_PACKAGE}:${constraint}`, '--no-interaction'], { cwd: themeDir });

  if (required.code !== 0) {
    log.error(`Could not require ${CORE_PACKAGE} at ${constraint} in ${themeDir}.`);
    return false;
  }

  return true;
}

/**
 * The version of wonderpress-core that is actually installed.
 *
 * Read from the lock file rather than restated from a constant, so the record
 * in .wonderpressrc cannot drift from what is on disk. Returns null when no
 * theme resolved the package, which config.write() should record as honestly
 * as it records a version.
 *
 * @returns {String|null} The resolved version, or null.
 **/
function readCoreVersion() {

  for (const themeDir of themeDirsWithManifest()) {
    const lockPath = path.join(themeDir, 'composer.lock');

    if (!fs.existsSync(lockPath)) {
      continue;
    }

    try {
      const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const pkg = (lock.packages || []).find((p) => p.name === CORE_PACKAGE);

      if (pkg) {
        return pkg.version;
      }
    } catch (e) {
      // A malformed lock file is worth saying out loud, but it is not worth
      // failing an otherwise successful init over.
      log.warn(`Could not read ${lockPath}: ${e.message}`);
    }
  }

  return null;
}

/**
 * Empty a directory for `init --clean-slate`, dotfiles included.
 *
 * This used to be `rm -rf ${dir}/*` and `rm -rf ${dir}/.*` through a shell:
 * no `rm` on Windows, a glob that split on spaces in the path, and a `.*`
 * whose meaning depends on the shell (in some, it matches `..`). fs-extra's
 * emptyDir removes the directory's contents and nothing else, with no shell
 * and no glob.
 *
 * Refuses the filesystem root and the home directory outright: there is no
 * project that lives there, and a typo in --dir should not be able to cost
 * someone their machine.
 *
 * @param {String} dir
 * @returns {{ ok: Boolean, error?: String }}
 **/
export function cleanSlate(dir) {
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
    return { ok: false, error: `Refusing to clear ${resolved}: --clean-slate empties a project directory, and that is not one.` };
  }
  try {
    fs.emptyDirSync(resolved);
  } catch (e) {
    return { ok: false, error: `Could not clear ${resolved}: ${e.message}` };
  }
  return { ok: true };
}

/**
 * Initialize a new or existing Wonderpress Development Environment.
 *
 * Five steps — scaffold, assets, wordpress, core, theme — reported through
 * src/init-progress.js. In human mode the reporter is silent and the phases'
 * own log lines are the output, as they always were. Under `--format json`
 * each step's start and end is an event line on stdout, the log lines go to
 * stderr, and the run ends with one envelope (ARCHITECTURE.md, "App-facing
 * commands and the version pin").
 **/
export async function init(dir, initConfig) {

  initConfig = initConfig || {};
  const interactive = initConfig.interactive !== false;

  // Set the target directory
  const targetDir = dir || process.cwd();
  const root = path.resolve(targetDir);

  const backend = env.getCurrent();
  const report = progress.createReporter();
  const outcome = { theme: null, url: null };

  report.describe(() => {
    const rc = config.read(root).data;
    return {
      root,
      backend: backend.name,
      theme: outcome.theme || initConfig.theme || null,
      namespace: rc.namespace || null,
      cliVersion: rc.cliVersion || null,
      url: outcome.url,
    };
  });

  // The app reads stdout as protocol, and a prompt would write to it and then
  // wait for a human who is not there.
  if (report.json && interactive) {
    const message = 'init --format json never prompts, so it needs --yes.';
    log.error(message);
    return report.finish(false, { code: 'usage', message, hint: 'Pass --yes, and every setting as a flag (see `wonderpress init --help`).' });
  }

  report.trapSignals();

  try {
    return await runInit(targetDir, initConfig, { backend, interactive, report, outcome });
  } finally {
    report.releaseSignals();
  }
}

async function runInit(targetDir, initConfig, { backend, interactive, report, outcome }) {

  // Whatever the backend needs before we write anything to disk. Failing here
  // costs 200ms; failing after the scaffold clone and npm install costs
  // minutes.
  //
  // The real backends' preflight() is `wonderpress doctor` scoped to that
  // backend (src/doctor.js), so a failed init and doctor say the same thing.
  const preflight = await backend.preflight();
  // Warnings do not stop init (today: the host backend on Windows).
  (preflight.warnings || []).forEach((warning) => log.warn(warning));
  if (!preflight.ok) {
    const errors = preflight.errors || [];
    errors.forEach((error) => log.error(error));
    // Exit non-zero. This used to `return 0`, so an init that refused to run
    // for want of WP-CLI still told the shell it had succeeded.
    process.exitCode = 1;
    // Not a step: the envelope's error, in doctor's words.
    return report.finish(false, {
      code: 'preflight',
      message: errors.length
        ? `${errors.length} prerequisite check${errors.length === 1 ? '' : 's'} failed. Run \`wonderpress doctor\` for the full list.`
        : 'A prerequisite check failed. Run `wonderpress doctor` for the full list.',
      hint: errors.length ? errors.join('\n') : null,
    });
  }

  // DO NOT set process.cwd() to targetDir yet.

  // Clear the entire directory?
  if (initConfig.cleanSlate) {
    if (targetDir == '.') {
      const message = `The --clean-slate does not work when initializing into your current directory. Please navigate outside of this directory and try again.`;
      log.error(message);
      return report.finish(false, { code: 'usage', message, hint: 'Pass --dir <path> from outside the directory.' });
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
      const wiped = cleanSlate(targetDir);
      if (!wiped.ok) {
        log.error(wiped.error);
        process.exitCode = 1;
        return report.finish(false, { code: 'clean_slate', message: wiped.error, hint: null });
      }
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
  const fresh = ! await config.exists(process.cwd());

  // Step 1: the scaffold. Done at once on an existing environment.
  const scaffolded = await report.step('scaffold', async () => {
    if (!fresh) {
      return true;
    }

    log.info(`Installing Wonderpress Development Environment into ${process.cwd()}`);

    // Clone and prune the Wonderpress Development Environment
    const tmpDir = '.wonderpress-tmp';
    await fs.emptyDirSync(tmpDir);

    const envSource = resolveEnvSource();
    const envRefArg = envSource.ref ? ` --branch ${envSource.ref}` : '';
    // Silent: git's protocol dump (--progress --verbose, inherited stdio) sat
    // flush-left in the middle of the gutter log. Failures still print stderr.
    // Async so a cancel can stop it (src/proc.js).
    const cloned = await runAsync('git', ['clone', envSource.repo, ...(envSource.ref ? ['--branch', envSource.ref] : []), tmpDir, '--depth=1'], { silent: true });

    // Stop rather than carry on into a half-scaffolded directory. This used to
    // ignore the exit code entirely, so a failed clone produced an environment
    // with no theme and an error message about something else entirely.
    if (cloned.code !== 0) {
      const message = `Could not clone the environment scaffold from ${envSource.repo}${envRefArg}.`;
      log.error(message);
      const detail = String(cloned.stderr || cloned.stdout || '').trim();
      if (detail) {
        log.info(detail);
      }
      return { ok: false, error: { code: 'scaffold', message, hint: detail || null } };
    }

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
    return true;
  });
  if (!scaffolded) {
    return false;
  }

  // Step 2: Static Kit, into the scaffold's theme. Done at once on an existing
  // environment, which already has its static/ tree.
  const assetsInstalled = await report.step('assets', async () => {
    if (!fresh) {
      return true;
    }
    const staticCli = await importStaticKit();
    const installed = await installStaticKit(staticCli, `./wp-content/themes/wonderpress/static`, {
      init: true,
      name: '404,archive,author,category,index,page,search,single,tag',
    });
    if (installed && installed.ok === false) {
      const error = installed.error || {};
      const message = error.message || 'Static Kit could not be installed.';
      log.error(message);
      return { ok: false, error: { code: 'assets', message, hint: error.hint || null } };
    }
    return true;
  });
  if (!assetsInstalled) {
    return false;
  }

  // Step 3: WordPress — the backend's prepare and provision.
  const wordpressInstalled = await report.step('wordpress', async () => {
    // Record which backend built this environment, as soon as there is a root
    // to record it in — not at the end. A provision that fails halfway must
    // still be discoverable as the kind of environment it is, or the next
    // command resolves the wrong backend and does something incoherent.
    //
    // The block namespace is pinned at the same moment and for a stronger
    // reason: it is written into the client's content as `<!-- wp:acme/hero -->`,
    // so it must be decided once and never drift. Recording it here means a
    // later theme rename cannot silently re-namespace content already placed.
    //
    // The CLI version is pinned alongside them, but only when the project has
    // no pin yet. Re-running init with a newer CLI must not quietly bump a
    // committed pin — moving it is a deliberate edit, and the mismatch warning
    // says when one is due.
    config.write(process.cwd(), {
      environment: { backend: backend.name },
      namespace: resolveProjectNamespace(process.cwd(), initConfig),
      ...(config.getCliVersion(process.cwd()) ? {} : { cliVersion: pkg.version }),
    });

    // Anything the backend needs on disk before it can provision.
    const prepared = await backend.prepare(initConfig);
    if (! reportBackendStep(prepared)) {
      return { ok: false, error: backendError('prepare', prepared) };
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
      return { ok: false, error: backendError('provision', provisioned) };
    }

    return true;
  });
  if (!wordpressInstalled) {
    return false;
  }

  // Step 4: the Composer packages, chiefly wonderpress-core.
  const coreReady = await report.step('core', async () => {
    // Install the theme's Composer dependencies, chiefly wonderpress-core.
    //
    // Core used to be cloned into wp-content/mu-plugins from a pinned git tag.
    // It is a theme dependency now: nothing in it needs mu-plugin load order —
    // its earliest hook is `init` — and it cannot function without a theme at
    // all, since it registers the blocks in the theme's blocks/ directory and
    // resolves its partial views through locate_template(). Installing it into
    // the theme means deleting the theme removes Wonderpress with it, and
    // upgrading is `composer update` in one directory.
    if (! await installCore()) {
      return false;
    }

    // The environment root's own Composer packages — the phpcs toolchain that
    // `wonderpress lint` runs. Separate from the theme's: different manifest,
    // different purpose, and the root one ships no runtime code.
    if (! await composer.installComposer(process.cwd())) {
      return false;
    }

    // Recorded only now, unlike the backend above: the backend is worth knowing
    // even when a provision failed halfway, but a core version is a claim about
    // what is on disk, and claiming one we failed to install would be worse than
    // recording nothing.
    //
    // The version that was ACTUALLY resolved, read back out of the lock file
    // rather than restated from a constant. A project built from a branch should
    // say so when someone later asks which core it is running.
    config.write(process.cwd(), { core: readCoreVersion() });
    return true;
  });
  if (!coreReady) {
    process.exitCode = process.exitCode || 1;
    return false;
  }

  // Step 5: activate a theme, then the README and AGENTS.md.
  const themeReady = await report.step('theme', async () => {
    // Activate a theme. --theme wins; otherwise auto-activate a lone theme, and
    // prompt (interactive) or error (headless) when several exist.
    log.info(`Checking for themes that can be activated...`);
    let toActivate = null;
    if (initConfig.theme) {
      toActivate = initConfig.theme;
    } else {
      const themes = await wordpress.getAllThemes();

      if (themes.length == 1) {
        toActivate = themes[0].name;
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
          toActivate = themeToActivateAnswer.themeToActivate || null;
        } else {
          log.error('Multiple themes found. Pass --theme <name> to choose which to activate.');
          // A human --yes run carries on, as it always has. The app cannot see
          // a log line, so for it this is the usage error naming the flag.
          if (report.json) {
            return {
              ok: false,
              error: {
                code: 'usage',
                message: `Multiple themes found (${themes.map((theme) => theme.name).join(', ')}).`,
                hint: 'Pass --theme <name> to choose which to activate.',
              },
            };
          }
        }
      }
    }

    if (toActivate) {
      log.info(`Activating ${toActivate} theme...`);
      const activated = await wordpress.activateTheme(toActivate);
      if (activated && activated.code !== undefined && activated.code !== 0) {
        const message = `Could not activate the ${toActivate} theme.`;
        log.error(message);
        const detail = String(activated.stderr || activated.stdout || '').trim();
        return { ok: false, error: { code: 'theme', message, hint: detail || 'Is it installed? Pass --theme <name> to choose another.' } };
      }
      outcome.theme = toActivate;
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
        // Headless: generate a README named after the site title. Never
        // undefined: with no --project-* flag at all, readme.create() falls
        // back to its interactive wizard, which --yes must never reach.
        await readme.create({ '--project-name': (initConfig.wp && initConfig.wp.title) || 'Wonderpress' });
      }
    }

    return true;
  });
  if (!themeReady) {
    process.exitCode = process.exitCode || 1;
    return false;
  }

  log.success(`The Wonderpress environment has been initialized!`);

  reportWhereTheSiteIs(backend, initConfig);

  try {
    const agents = await import('./agents.js');
    const themeName = (initConfig && initConfig.theme) || wordpress.themesOnDisk()[0];
    if (themeName) {
      agents.writeAgentFiles({
        root: process.cwd(),
        themeDir: path.join(wordpress.pathToThemesDir, themeName),
      });
    }
  } catch (err) {
    log.warn(`Could not write AGENTS.md: ${err.message}`);
  }

  outcome.url = typeof backend.siteUrl === 'function' ? backend.siteUrl(initConfig) : null;

  return report.finish(true);
}

/**
 * A backend lifecycle failure as a step error: the first line says what
 * failed, the rest (commands to run, output) is the hint.
 **/
function backendError(code, result) {
  const lines = (result.errors || []).join('\n').split('\n');
  const message = (lines.shift() || `The backend's ${code} failed.`).trim();
  const hint = lines.join('\n').trim();
  return { code, message, hint: hint || null };
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

  log.card([
    ['Site', url],
    ['Admin', `${url}/wp-admin`],
    ['Login', `${credentials}${note}`],

    // The two backends differ on whether anything still has to be started, and
    // getting that wrong sends someone to a dead port.
    ['Serving', backend.capabilities && backend.capabilities.detachedServer
      ? 'already — this backend keeps running in the background'
      : 'not yet — run `wonderpress server`'],
  ]);
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
    // The backend was chosen from the shell's cwd before dispatch; now that
    // the environment root is known, make sure it matches what THIS root was
    // built with. See env.rebind().
    env.rebind(path);
    return true;
  }

  log.error(`This does not appear to be a Wonderpress Development Environment.`);
  return false;
}

/**
 * Get the current version.
 **/
export function version(args = {}, ctx = {}) {
  const data = {
    name: pkg.name,
    version: pkg.version,
    // { pinned, current } when this runs inside a project pinned to another
    // CLI version, else null. Resolved once by cli.js, which also prints the
    // human warning; null when called outside the CLI entry point.
    cliVersionMismatch: ctx.cliVersionMismatch ?? null,
  };
  if (format.isJson()) {
    return format.ok(data);
  }
  log.raw(`Wonderpress CLI ${pkg.version}`);
  return true;
}

