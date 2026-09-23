import arg from 'arg';
import * as agents from './agents.js';
import * as block from './block.js';
import * as core from './core.js';
import * as env from './env/index.js';
import * as format from './format.js';
import * as help from './help.js';
import * as lint from './lint.js';
import * as log from './log.js';
import * as mcp from './mcp.js';
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
    '--sub': [String],
    '--json': String,
    '--block': Boolean,
    '--js': Boolean,
    '--no-manifest': Boolean,
    '--no-style': Boolean,
    '--all': Boolean,
    '--dry-run': Boolean,
    '--properties-only': Boolean,
    '--slug': String,
    '--format': String,

    // partial remove
    '--with-block': Boolean,
    '--confirm': Boolean,

    // agents write
    '--force': Boolean,

    // lint
    '--axe': Boolean,
    '--budget': Boolean,

    // template create
    '--lock': String,
    '--section': [String],

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

  format.configure(args);

  if (args['--format'] && args['--format'] !== 'json') {
    log.error(`Unknown --format "${args['--format']}" (expected json, or omit for human output).`);
    process.exitCode = format.EXIT_USAGE;
    return format.fail(
      { code: 'usage', message: `Unknown --format "${args['--format']}"`, hint: 'Use --format json or omit the flag.' },
      format.EXIT_USAGE,
    );
  }

  let cmd = args._[0];

  if (cmd === 'mcp') {
    format.setMcp();
  }

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
    process.exitCode = format.EXIT_FAIL;
    return format.fail({
      code: 'env',
      message: `Unknown environment backend: ${resolution.unknown}`,
      hint: `Expected one of: ${env.names().join(', ')}`,
    });
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
    // Accepting this one was worse than ignoring it: wp-env's admin is always
    // `admin`, so a different --admin-user quietly created a SECOND account and
    // left the user with two administrators, only one of which had a password
    // they knew.
    if (backend.capabilities.honorsAdminUser === false && args['--admin-user'] !== undefined) {
      unsupported.push('--admin-user');
    }
    if (unsupported.length) {
      // Say WHY per flag rather than one blanket sentence about the database:
      // the reasons genuinely differ, and "fixed by the container" explains
      // nothing about a username.
      const why = {
        '--admin-user': 'its first user is created by wp-env and is always `admin`',
        '--wp-url': 'it serves on localhost:<port from .wp-env.json>',
      };
      const reasons = unsupported.map((f) => why[f] || 'its database is fixed at root/password/wordpress');
      log.error(`The ${backend.name} backend cannot honor ${unsupported.join(', ')} — ${[...new Set(reasons)].join('; ')}.\nDrop the flag, or use the host backend (omit --env).`);
      process.exitCode = format.EXIT_FAIL;
      return format.fail({
        code: 'env',
        message: `The ${backend.name} backend cannot honor ${unsupported.join(', ')}`,
        hint: 'Drop the flag, or use the host backend (omit --env).',
      });
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
      await server.command(args._[1] || 'start', args);
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
    case 'agents':
      await agents.command(args._[1], args);
      break;
    case 'mcp':
      await mcp.command(args);
      break;
    default:
      // Unknown commands used to fall through to nothing at all: no message, no
      // non-zero exit. A typo looked exactly like success.
      log.error(`Unknown command: ${cmd}`);
      if (!format.isJson()) {
        help.show();
      }
      process.exitCode = format.EXIT_FAIL;
      format.fail({
        code: 'unknown_command',
        message: `Unknown command: ${cmd}`,
        hint: 'Run `wonderpress help`.',
      });
      break;
  }
}
