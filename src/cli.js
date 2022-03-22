const arg = require('arg');
const core = require('./core');
const lint = require('./lint');
const partial = require('./partial');
const readme = require('./readme');
const server = require('./server');
const template = require('./template');

export async function cli() {

  const options = {
    '--clean-slate'     : Boolean,
    '--dir'             : String,
    '--fix'             : Boolean,
    '--init'            : Boolean,
    '--name'            : String,
    '--version'         : Boolean,

    // Shortcuts
    '-d'        : '--dir',
    '-f'        : '--fix',
    '-i'        : '--init',
    '-n'        : '--name',
    '-v'        : '--version',
  }

  const args = arg(
    options,
    {
      argv: arguments[0].slice(2),
      permissive: true
    }
  );

  let cmd = args._[0];

  // Handle for no cmd
  if(cmd == undefined) {
    if(args['--version']) {
      cmd = 'version';
    }
  }
  
  switch(cmd) {
    case 'partial':
      await partial.command(args._[1],args);
      break;
    case 'init':
      await core.command('init',args);
      break;
    case 'server':
      await server.command('start',args);
      break;
    case 'lint':
      await lint.command('theme',args);
      break;
    case 'readme':
      await readme.command(args._[1],args);
      break;
    case 'template':
      await template.command(args._[1],args);
      break;
    case 'version':
      await core.command('version',args);
      break;
  }
}
