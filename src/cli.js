import arg from 'arg';
import inquirer from 'inquirer';
import { configureWordPress, installBrassTacksTheme, lintTheme, setup } from './main';

const shelljs = require('shelljs');

const defaultFn = 'setup';

function parseArgumentsIntoOptions(rawArgs) {
 const args = arg(
   {
     '--clean-slate': Boolean,
     // '--yes': Boolean,
     // '--install': Boolean,
     // '-g': '--git',
     // '-y': '--yes',
     // '-i': '--install',
   },
   {
     argv: rawArgs.slice(2),
   }
 );
 return {
   cleanSlate: args['--clean-slate'] || false,
   // git: args['--git'] || false,
   fn: args._[0],
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
         'name': 'Setup WonderPress',
         'value': 'setup'
       },
       {
         'name': 'Configure WordPress',
         'value': 'configure_wordpress'
       },
	     {
	     	'name': 'Install Bebop',
	     	'value': 'install_brass_tacks'
	     },
       {
         'name': 'Lint a theme',
         'value': 'lint'
       }
     ],
     default: defaultFn,
   });
 }

 // if (!options.git) {
 //   questions.push({
 //     type: 'confirm',
 //     name: 'git',
 //     message: 'Initialize a git repository?',
 //     default: false,
 //   });
 // }

 const answers = await inquirer.prompt(questions);
 return {
   ...options,
   fn: options.fn || answers.fn,
   // git: options.git || answers.git,
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
    case 'configure_wordpress':
      await configureWordPress();
      break;
    case 'install_brass_tacks':
      await installBrassTacksTheme();
      break;
    case 'lint':
      await lintTheme();
      break;
  }
}