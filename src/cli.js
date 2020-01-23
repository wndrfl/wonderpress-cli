import arg from 'arg';
import inquirer from 'inquirer';
import { installBebopTheme, lintTheme, setup, upgradeWonderPress } from './main';

function parseArgumentsIntoOptions(rawArgs) {
 const args = arg(
   {
     // '--git': Boolean,
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
   // skipPrompts: args['--yes'] || false,
   // git: args['--git'] || false,
   // fn: args._[0],
   // runInstall: args['--install'] || false,
 };
}

async function promptForMissingOptions(options) {
 if (options.skipPrompts) {
   return {
     ...options,
     // fn: options.fn || defaultFn,
   };
 }

 const defaultFn = 'setup';
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
	     	'name': 'Install Bebop',
	     	'value': 'install_bebop'
	     },
       {
         'name': 'Lint a theme',
         'value': 'lint'
       },
       {
         'name': 'Upgrade WonderPress',
         'value': 'upgrade_wonderpress'
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
  options = await promptForMissingOptions(options);

  switch(options.fn) {
    case 'setup':
      await setup();
      break;
    case 'install_bebop':
      await installBebopTheme();
      break;
    case 'lint':
      await lintTheme();
      break;
    case 'upgrade_wonderpress':
      await upgradeWonderPress();
      break;
  }

}