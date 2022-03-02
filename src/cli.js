const arg = require('arg');
const core = require('./core');
const lint = require('./lint');
const partial = require('./partial');
const readme = require('./readme');
const server = require('./server');

export async function cli() {

  const options = {
    '--clean-slate'     : Boolean,
    '--dir'             : String,
    '--fix'             : Boolean,
    '--init'            : Boolean,
    '--name'            : String,

    // Shortcuts
    '-d'        : '--dir',
    '-f'        : '--fix',
    '-n'        : '--name',
  }

  const args = arg(
    options,
    {
      argv: arguments[0].slice(2),
      permissive: true
    }
  );

  const cmd = args._[0];
  
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
  }
}
