import arg from 'arg';
import inquirer from 'inquirer';

const core = require('./core');
const lint = require('./lint');
const readme = require('./readme');

const shelljs = require('shelljs');

const defaultFn = 'setup';

function parseArgumentsIntoOptions(rawArgs) {

  const args = arg(
    {
      '--clean-slate' : Boolean,
      '--fix'         : Boolean,

      '-c'            : '--clean-slate',
      '-f'            : '--fix',
    },
    {
      argv: rawArgs.slice(2),
    }
  );

  return {
    cleanSlate: args['--clean-slate'] || false,
    fix: args['--fix'] || null,
    fn: args._[0],
  };
}

async function promptForMissingOptions(options) {

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'fn',
      message: 'What would you like to do?',
      choices: [
        {
          'name': 'Setup the Wonderpress Development Environment',
          'value': 'setup'
        },
        {
          'name': 'Start a development server',
          'value': 'server'
        },
        {
          'name': 'Install the Wonderpress Theme',
          'value': 'install_wonderpress_theme'
        },
        {
          'name': 'Lint the active theme',
          'value': 'lint'
        },
        {
          'name': 'Create a README',
          'value': 'readme'
        }
      ],
      default: defaultFn,
    }
  ]);

  return {
    ...options,
    fn: options.fn || answers.fn,
  };

}

export async function cli(args) {
	
  let options = parseArgumentsIntoOptions(args);

  // Clear the entire directory?
  if(options.cleanSlate) {
    console.log('🚨 Clearing the entire directory (clean slate!)');
    shelljs.exec('rm -rf ./* && rm -rf .*');
  }

  if(!options.fn) {
    options = await promptForMissingOptions(options);
  }

  switch(options.fn) {
    case 'setup':
      await core.setup();
      break;
    case 'server':
      await core.startServer();
      break;
    case 'lint':
      await lint.lintTheme(null,options.fix);
      break;
    case 'install_wonderpress_theme':
      await core.installWonderpressTheme();
      break;
    case 'readme':
      await readme.createReadme();
      break;
  }
}