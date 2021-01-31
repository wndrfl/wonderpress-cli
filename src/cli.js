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

      '-c'            : '--clean-slate',
    },
    {
      argv: rawArgs.slice(2),
    }
  );

  return {
    cleanSlate: args['--clean-slate'] || false,
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
          'name': 'Setup Wonderpress Development Environment',
          'value': 'setup'
        },
        {
          'name': 'Start server',
          'value': 'server'
        },
        {
          'name': 'Install Wonderpress Theme',
          'value': 'install_wonderpress_theme'
        },
        {
          'name': 'Lint a theme',
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
    shelljs.exec('rm -rf ./*');
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
      await lint.lintTheme();
      break;
    case 'install_wonderpress_theme':
      await core.installWonderpressTheme();
      break;
    case 'readme':
      await readme.createReadme();
      break;
  }
}