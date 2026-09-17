import arg from 'arg';
import * as block from './block.js';
import * as core from './core.js';
import * as env from './env/index.js';
import * as help from './help.js';
import * as lint from './lint.js';
import * as log from './log.js';
import * as partial from './partial.js';
import * as readme from './readme.js';
import * as server from './server.js';
import * as template from './template.js';

export async function cli() {
  const options = {
    '--clean-slate': Boolean,
    '--dir': String,
    '--env': String,
    '--fix': Boolean,
    '--init': Boolean,
    '--name': String,
    '--help': Boolean,
    '--version': Boolean,

    // partial create
    '--acf': Boolean,
    '--no-template': Boolean,
    '--template-name': String,
    '--theme': String,
    '--namespace': String,
    '--prop': [String],
    '--json': String,
    '--block': Boolean,
    '--js': Boolean,
    '--no-manifest': Boolean,
    '--no-style': Boolean,

    // partial remove
    '--with-block': Boolean,

    // readme create
    '--project-name': String,
    '--project-description': String,
    '--github-url': String,
    '--production-url': String,
    '--stage-url': String,
    '--dev-url': String,

    // init (headless)
    '--yes': Boolean,
    '--db-host': String,
    '--db-user': String,
    '--db-name': String,
    '--db-password': String,
    '--wp-url': String,
    '--wp-title': String,
    '--admin-user': String,
    '--admin-email': String,
    '--admin-password': String,
    '--skip-readme': Boolean,
    '--readme': Boolean,

    // Shortcuts
    '-d': '--dir',
    '-f': '--fix',
    '-i': '--init',
    '-h': '--help',
    '-n': '--name',
    '-v': '--version',
    '-y': '--yes',
  };

  const args = arg(
    options,
    {
      argv: arguments[0].slice(2),
      permissive: true
    }
  );

  let cmd = args._[0];

  // Handle for no cmd
  if (cmd == undefined) {
    if (args['--version']) {
      cmd = 'version';
    }
  }

  // `wonderpress`, `wonderpress help`, `wonderpress --help`: orient, don't sit
  // silently. Bare invocation used to print nothing at all and exit 0, which
  // reads as "worked" rather than "you have not said what you want yet".
  if (cmd === undefined || cmd === 'help') {
    return help.show(args._[1]);
  }

  // `wonderpress <command> --help` / `<command> help` -> that command's screen.
  if (help.requested(args) && help.has(cmd)) {
    return help.show(cmd);
  }

  // Select the environment backend before dispatching: --env, then
  // WONDERPRESS_ENV, then what this environment was built with, then a
  // .wp-env.json sitting at its root, then the host backend.
  //
  // `init` may be creating an environment that does not exist yet, so it
  // resolves against its target directory rather than an existing root.
  const envRoot = cmd === 'init'
    ? (args['--dir'] || process.cwd())
    : ((await core.getRootDir()) || process.cwd());

  const resolution = env.resolve({
    flag: args['--env'],
    envVar: process.env.WONDERPRESS_ENV,
    root: envRoot,
  });

  if (resolution.unknown) {
    log.error(`Unknown environment backend: ${resolution.unknown} (expected one of: ${env.names().join(', ')})`);
    process.exitCode = 1;
    return;
  }

  if (resolution.mismatch) {
    log.warn(`This environment was built with the ${resolution.persisted} backend, but you asked for ${resolution.name}.`);
  }

  {
    // Refuse flags the backend cannot honor rather than accepting and ignoring
    // them. wp-env fixes its database at root/password/wordpress and serves on
    // localhost:<port from .wp-env.json>, so a --db-name it silently dropped is
    // how someone loses a day.
    const backend = env.getCurrent();
    const unsupported = [];
    if (!backend.capabilities.honorsDbFlags) {
      unsupported.push(...['--db-host', '--db-user', '--db-password', '--db-name'].filter((f) => args[f] !== undefined));
    }
    if (!backend.capabilities.honorsSiteHostname && args['--wp-url'] !== undefined) {
      unsupported.push('--wp-url');
    }
    if (unsupported.length) {
      log.error(`The ${backend.name} backend cannot honor ${unsupported.join(', ')}.\nIts database and site URL are fixed by the container. Drop the flag, or use the host backend (omit --env).`);
      process.exitCode = 1;
      return;
    }
  }

  switch (cmd) {
    case 'partial':
      await partial.command(args._[1], args);
      break;
    case 'block':
      await block.command(args._[1], args);
      break;
    case 'init':
      await core.command('init', args);
      break;
    case 'destroy':
      await core.destroy(args);
      break;
    case 'server':
      await server.command('start', args);
      break;
    case 'lint':
      await lint.command('theme', args);
      break;
    case 'readme':
      await readme.command(args._[1], args);
      break;
    case 'template':
      await template.command(args._[1], args);
      break;
    case 'version':
      await core.command('version', args);
      break;
    default:
      // Unknown commands used to fall through to nothing at all: no message, no
      // non-zero exit. A typo looked exactly like success.
      log.error(`Unknown command: ${cmd}`);
      help.show();
      process.exitCode = 1;
      break;
  }
}
