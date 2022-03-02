import inquirer from 'inquirer';

const core = require('./core');
const fs = require('fs');
const log = require('./log');
const mustache = require('mustache');
const sh = require('shelljs');
const wordpress = require('./wordpress');

export async function command(subcommand, args) {
	switch(subcommand) {
		case 'create':
			await create(args);
			break;
	}

	return true;
}

export async function create(args) {

	const dir = args['--dir'] ? args['--dir'] : '.';
	process.chdir(dir);

	if(! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	log.info('Starting partial creation wizard...');

	const theme = await wordpress.getActiveTheme();
	const themeDir = await wordpress.pathToThemesDir + '/' + theme.name;

	log.instructions('In Wonderpress, a "partial" is a PHP class that helps render a reusable view. Here we will create the PHP class (and optionally the PHP template for the view). Please answer the following questions:');

	const partialClassPath = require.resolve('./templates/partial-class.template.txt');
	const partialClassTemplate = fs.readFileSync(partialClassPath, 'utf8');
	const partialClassFilePath = `${themeDir}/src/partials`;

	const partialTemplatePath = require.resolve('./templates/partial-template.template.txt');
	const partialTemplateTemplate = fs.readFileSync(partialTemplatePath, 'utf8');
	const partialTemplateRelativeThemePath = './partials';
	const partialTemplateFilePath = `${themeDir}/partials`;

	let params = {
		class_name : '',
		has_partial_template : false,
		is_acf_compatible : false,
		partial_template_path : '',
		properties : [],
	};

	let step = 1;
	while(step !== false) {
		if(step == 1) {

			let answers = await inquirer.prompt([
				{
					type: 'input',
					name: 'class_name',
					message: 'What should we name this class?',
					suffix: '\nAccording to WordPress standards, the class name must be in snake-case format:',
					validate: function(answer) {
						const valid = /^([A-Z][a-z]*)(_[A-Z][a-z]+)*$/.test(answer);
						if(!valid) {
							log.info('');
							log.error('The class name must be in snake-case format.');
							log.info('Here\'s an example of a properly formatted class name in WordPress: Example_Class');
						}
						return valid;
					}
				},
				{
					type: 'confirm',
					name: 'is_acf_compatible',
					message: 'Should this partial be configured as ACF compatible?',
					suffix: '\nIf you don\'t know, type "N":',
					default: false,
				},
				{
					type: 'confirm',
					name: 'has_partial_template',
					message: 'Should we create a view template for this partial?',
					suffix: `\nThis file will be created in ${partialTemplateFilePath}`,
					default: true
				},
				{
					type: 'input',
					name: 'partial_template_name',
					message: 'What should we name the view template?',
					default: function(answers) {
						let name = answers.class_name.toLowerCase().replace('_','-') + '.php';
						return name;
					},
					when: function(answers) {
						return answers.has_partial_template;
					},
					validate: function(input, answers) {
						const valid = /^[a-z\-]*\.php$/.test(input);
						if(!valid) {
							log.info('');
							log.error('Please only use lowercase characters and dashes, and make sure the name ends with .php');
							log.info('Here\'s an example: my-template-name.php');
						}
						return valid;
					}
				}
			]);

			params.class_name = answers.class_name;
			params.is_acf_compatible = answers.is_acf_compatible;
			params.has_partial_template = answers.has_partial_template;
			params.partial_template_name = answers.partial_template_name;
			params.partial_template_path = partialTemplateRelativeThemePath + '/' + answers.partial_template_name;
			
			step = 2;	

		} else if(step == 2) {

			if(!params.properties.length) {
				log.instructions('Time to confgure for the properties for this partial. Properties are values that may be passed into the partial class during instantiation, and these values will be validated and passed to the view template for display.');
			}

			const addMessage = params.properties.length ? 'Would you like to define another property for this partial?' : 'Would you like to define a property for this partial?';
			
			let answers = await inquirer.prompt([
				{
					type: 'confirm',
					name: 'add_another',
					message: addMessage
				},
				{
					type: 'input',
					name: 'name',
					message: 'Whats the name of this property?',
					suffix: '\nThis should be all lowercase letters or underscores (no dashes, spaces, or numbers):',
					when: function(answers) {
						return answers.add_another;
					}
				},
				{
					type: 'list',
					name: 'type',
					message: 'What type of property is this?',
					suffix: '\nWonderpress will validate this property accordingly when rendering:',
					choices: [
						'array',
						'boolean',
						'object',
						'string'
					],
					default: 'string',
					when: function(answers) {
						return answers.add_another;
					}
				},
				{
					type: 'input',
					name: 'description',
					message: 'Briefly describe the property',
					suffix: '\nThis will help developers understand its purpose:',
					when: function(answers) {
						return answers.add_another;
					}
				},
				{
					type: 'confirm',
					name: 'required',
					message: 'Should this property be validated as required?',
					suffix: '\nIf "yes", then Wonderpress will enforce a value upon instantiation:',
					when: function(answers) {
						return answers.add_another;
					}
				}
			]);

			if(!answers.add_another) {
				log.info('Property configuration is complete. Moving on...');
				step = false;
			} else {
				params.properties.push(answers);
			}
		}
	}
	

	// Create the class
	const partialClassOutput = mustache.render(partialClassTemplate, params);
	const fileName = `class-${params.class_name.toLowerCase().replace('_','-')}`;
	const filePath = `${partialClassFilePath}/${fileName}.php`;
	await sh.exec(`cat > ${filePath} <<EOF
${partialClassOutput}`);
	log.success(`Partial class created at: ${filePath}`);

	// Create the template (optional)
	if(params.has_partial_template && params.partial_template_name) {
		const partialTemplateOutput = mustache.render(partialTemplateTemplate, {
			template_class_name : params.partial_template_name.replace('.php',''),
			template_name: params.partial_template_name.replace('.php','')
		});
		const templateFilePath = `${partialTemplateFilePath}/${params.partial_template_name}`;	
		await sh.exec(`cat > ${templateFilePath} <<EOF
${partialTemplateOutput}`);
		log.success(`View template created at: ${templateFilePath}`);
	}




}