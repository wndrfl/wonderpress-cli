import arg from 'arg';
import * as block from './block.js';
import * as core from './core.js';
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
