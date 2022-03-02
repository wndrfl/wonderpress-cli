import inquirer from 'inquirer';

const core = require('./core');
const fs = require('fs');
const log = require('./log');
const mustache = require('mustache');
const sh = require('shelljs');

const readmeFilePath = 'README.md';

export async function command(subcommand, args) {
	switch(subcommand) {
		case 'create':
			await create(args);
			break;
	}

	return true;
}

export async function create(args) {

	const dir = args && args['--dir'] ? args['--dir'] : '.';
	process.chdir(dir);

	if(! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

  if(exists()) {
    log.warn(`A README file already exists at \`${readmeFilePath}\`. Skipping README creation.`);
    return true;
  }

	log.info('Creating README.md...');

	let path = require.resolve('./templates/readme.template.md');
	let data = fs.readFileSync(path, 'utf8');


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

	await sh.exec(`cat > ${readmeFilePath} <<EOF
${output}`);

	log.success('README created!');


}

export async function exists() {

  log.info(`Checking for the existence of a README file at \`${readmeFilePath}\`...`);

  if(await fs.existsSync(readmeFilePath)) {
    log.info(`README file found!`);
    return true;
  }

  log.info(`README file was not found.`);
  return false;
}
