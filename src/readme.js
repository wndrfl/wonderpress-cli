import fs from 'fs-extra';
import * as log from './log.js';
import inquirer from 'inquirer';
import mustache from 'mustache';

const readmeFileName = 'README.md';

// The README fields that can be supplied via flags.
const README_FLAGS = [
	'--project-name',
	'--project-description',
	'--github-url',
	'--production-url',
	'--stage-url',
	'--dev-url',
];

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch (subcommand) {
		case 'create':
			await create(args);
			break;
	}

	return true;
}

/**
 * Create a README file.
 *
 * Flag-driven first: --json or any --project-* flag creates the README
 * headlessly; otherwise the interactive wizard collects the same params. Both
 * paths converge on writeReadme(). Called with no args (e.g. from `init`) it
 * runs the wizard.
 **/
export async function create(args) {

	args = args || {};

	const dir = args['--dir'] || process.cwd();
	process.chdir(dir);

	// Check to make sure a README doesn't already exist
	if (await exists(process.cwd())) {
		log.warn(`A README file already exists. Skipping README creation.`);
		return true;
	}

	log.info('Creating README.md...');

	let params;
	try {
		if (args['--json']) {
			params = paramsFromJson(args['--json']);
		} else if (isHeadless(args)) {
			params = paramsFromFlags(args);
		} else {
			params = await runWizard();
		}
	} catch (err) {
		log.error(err.message);
		return false;
	}

	writeReadme(params);
	return true;
}

/**
 * Whether any README field was supplied via flags.
 **/
function isHeadless(args) {
	return README_FLAGS.some((flag) => args[flag] !== undefined);
}

/**
 * Build params from CLI flags, falling back to the same defaults as the wizard.
 **/
export function paramsFromFlags(args) {
	const projectName = args['--project-name'] || 'Wonderpress';
	return {
		project_name: projectName,
		project_description: args['--project-description'] || `The official WordPress environment for ${projectName}`,
		has_github: !!args['--github-url'],
		github_url: args['--github-url'] || '',
		production_url: args['--production-url'] || 'TBD',
		stage_url: args['--stage-url'] || 'TBD',
		dev_url: args['--dev-url'] || 'TBD',
	};
}

/**
 * Build params from a --json value: `@path/to/file.json` or an inline string.
 **/
export function paramsFromJson(raw) {
	let text;
	if (raw.startsWith('@')) {
		text = fs.readFileSync(raw.slice(1), 'utf8');
	} else {
		text = raw;
	}

	let spec;
	try {
		spec = JSON.parse(text);
	} catch (e) {
		throw new Error(`Could not parse --json input: ${e.message}`);
	}

	const projectName = spec.project_name || spec.name || 'Wonderpress';
	return {
		project_name: projectName,
		project_description: spec.project_description || spec.description || `The official WordPress environment for ${projectName}`,
		has_github: !!spec.github_url,
		github_url: spec.github_url || '',
		production_url: spec.production_url || 'TBD',
		stage_url: spec.stage_url || 'TBD',
		dev_url: spec.dev_url || 'TBD',
	};
}

/**
 * Render and write the README. Pure execution: no prompts.
 **/
export function writeReadme(params) {
	const template = fs.readFileSync(new URL('./templates/readme.mustache', import.meta.url), 'utf8');
	const output = mustache.render(template, params);
	fs.writeFileSync(readmeFileName, output);
	log.success('README created!');
}

/**
 * Interactive wizard — collects the same params the flags would.
 **/
async function runWizard() {
	const answers = await inquirer.prompt([
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
			default: function (answers) {
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
			when: function (answers) {
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

	return {
		project_name: answers.project_name,
		project_description: answers.project_description,
		has_github: answers.has_github,
		github_url: answers.github_url || '',
		production_url: answers.production_url,
		stage_url: answers.stage_url,
		dev_url: answers.dev_url,
	};
}

/**
 * Check to see if a README exists in a given directory
 **/
export async function exists(dir) {

	const path = `${dir}/${readmeFileName}`;

	log.info(`Checking for the existence of a README file at \`${path}\`...`);

	if (await fs.existsSync(`${path}`)) {
		log.info(`README file found!`);
		return true;
	}

	log.info(`README file was not found.`);
	return false;
}
