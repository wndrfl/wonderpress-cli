import inquirer from 'inquirer';

const fs = require('fs');
const log = require('./log');
const mustache = require('mustache');
const sh = require('shelljs');

export async function createReadme() {

	log.info('Creating README.md...');

	let path = require.resolve('./readme.template.md');
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

	await sh.exec(`cat > README.md <<EOF
${output}`);


}