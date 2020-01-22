import arg from 'arg';
import inquirer from 'inquirer';
import { setup } from './main';

function parseArgumentsIntoOptions(rawArgs) {
 const args = arg(
   {
     '--git': Boolean,
     '--yes': Boolean,
     '--install': Boolean,
     '-g': '--git',
     '-y': '--yes',
     '-i': '--install',
   },
   {
     argv: rawArgs.slice(2),
   }
 );
 return {
   skipPrompts: args['--yes'] || false,
   git: args['--git'] || false,
   fn: args._[0],
   runInstall: args['--install'] || false,
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
	     	'name': 'Setup WordPress',
	     	'value': 'setup'
	     },
	     {
	     	'name': 'Something else',
	     	'value': 'something'
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
 console.log(options);
 switch(options.fn) {
 	case 'setup':
		await setup(options);
 		break;
 }
}