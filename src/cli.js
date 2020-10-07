import arg from 'arg';
import inquirer from 'inquirer';
import { configureWordPress, installWonderpressTheme, lintTheme, setup, startServer } from './main';

const shelljs = require('shelljs');

const defaultFn = 'setup';

function parseArgumentsIntoOptions(rawArgs) {

  const args = arg(
    {
      '--clean-slate': Boolean,
    },
    {
      argv: rawArgs.slice(2),
    }
  );

  return {
    cleanSlate: args['--clean-slate'] || false,
    fn: args._[0],
    server: args['--clean-slate'] || false,
    // runInstall: args['--install'] || false,
  };
}

async function promptForMissingOptions(options) {

  if (options.skipPrompts) {
    return {
      ...options,
      fn: options.fn || defaultFn,
    };
  }

  const questions = [];
  if (!options.fn) {
    questions.push({
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
          'name': 'Configure WordPress',
          'value': 'configure_wordpress'
        },
        {
          'name': 'Install Wonderpress Theme',
          'value': 'install_wonderpress_theme'
        },
        {
          'name': 'Lint a theme',
          'value': 'lint'
        }
      ],
      default: defaultFn,
    });
  }

  const answers = await inquirer.prompt(questions);
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

  options = await promptForMissingOptions(options);

  switch(options.fn) {
    case 'setup':
      await setup();
      break;
    case 'server':
      await startServer();
      break;
    case 'lint':
      await lintTheme();
      break;
    case 'configure_wordpress':
      await configureWordPress();
      break;
    case 'install_wonderpress_theme':
      await installWonderpressTheme();
      break;
  }
}