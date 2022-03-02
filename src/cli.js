import arg from 'arg';
import inquirer from 'inquirer';

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
    '--force'           : Boolean,
    '--init'            : Boolean,
    '--name'            : String,

    // Shortcuts
    '-d'        : '--dir',
    '-f'        : '--force',
    '-n'        : '--name',
  }

  const args = arg(
    options,
    {
      argv: arguments[0].slice(2),
      permissive: true
    }
  );

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
      console.log('🚨 Clearing the entire directory (clean slate!)');
      require('child_process').execSync('rm -rf ./* && rm -rf .*');
    } else {
      console.log('You are safe. Cancelling the installation. Please try again without requesting a clean slate installation.');
      return;
    }
  }

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
