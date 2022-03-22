import inquirer from 'inquirer';

const core = require('./core');
const fs = require('fs');
const log = require('./log');
const mustache = require('mustache');
const sh = require('shelljs');

const readmeFileName = 'README.md';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch(subcommand) {
		case 'create':
			await create(args['--dir'] || null, {});
			break;
	}

	return true;
}

/**
 * Create a README file.
 **/
export async function create(dir, opts) {

	dir = dir || process.cwd();
	process.chdir(dir);

  opts = opts || {};

  // Check to make sure a README doesn't already exist
  if(await exists(process.cwd())) {
    log.warn(`A README file already exists. Skipping README creation.`);
    return true;
  }

	log.info('Creating README.md...');

  // Get the template file
	let path = require.resolve('./templates/readme.mustache');
	let data = fs.readFileSync(path, 'utf8');

  // Ask various questions to help create a README
	let readmeAnswers = await inquirer.prompt([
		{
			type: 'input',
			name: 'project_name',
			message: 'What is the human-friendly name of this project?',
			default: 'Wonderpress'
		},
		{
			type: 'input',
			name: 'project_description',
			message: 'Write a brief description of this project.',
			default: function(answers) {
				return 'The official WordPress environment for ' + answers.project_name;
			}
		},
		{
			type: 'confirm',
			name: 'has_github',
			message: 'Is there a Github repository for this project?',
			default: false
		},
		{
			type: 'input',
			name: 'github_url',
			message: 'What is the Github URL for this project?',
			when: function(answers) {
				return answers.has_github;
			}
		},
		{
			type: 'input',
			name: 'production_url',
			message: 'What will the Production URL of this project be?',
			default: 'TBD'
		},
		{
			type: 'input',
			name: 'stage_url',
			message: 'What will the Stage URL of this project be?',
			default: 'TBD'
		},
		{
			type: 'input',
			name: 'dev_url',
			message: 'What will the Dev URL of this project be?',
			default: 'TBD'
		}
	]);
	var output = mustache.render(data, readmeAnswers);

	await sh.exec(`cat > ${readmeFileName} <<EOF
${output}`);

	log.success('README created!');
}

/**
 * Check to see if a README exists in a given directory
 **/
export async function exists(dir) {

  const path = `${dir}/${readmeFileName}`;

  log.info(`Checking for the existence of a README file at \`${path}\`...`);

  if(await fs.existsSync(`${path}`)) {
    log.info(`README file found!`);
    return true;
  }

  log.info(`README file was not found.`);
  return false;
}
