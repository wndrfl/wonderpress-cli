import inquirer from 'inquirer';

const fs = require('fs');
const log = require('./log');
const mustache = require('mustache');
const sh = require('shelljs');
const wordpress = require('./wordpress');

export async function create() {

	log.info('Creating partial...');

	let path = require.resolve('./partial.template.txt');
	let data = fs.readFileSync(path, 'utf8');


	let params = {
		class_name : '',
		has_partial_template : false,
		is_acf_compatible : false,
		partial_template_path : '',
		properties : [],
	};

	let question = 1;
	while(question !== false) {
		if(question == 1) {
			let answers = await inquirer.prompt([
				{
					type: 'input',
					name: 'class_name',
					message: 'What is the class name?',
				},
				{
					type: 'confirm',
					name: 'is_acf_compatible',
					message: 'Is this partial ACF compatible?.',
					default: false,
					// default: function(answers) {
					// 	return 'The official WordPress environment for ' + answers.project_name;
					// }
				},
				{
					type: 'confirm',
					name: 'has_partial_template',
					message: 'Does this partial have a template?',
					default: false
				},
				{
					type: 'input',
					name: 'partial_template_path',
					message: 'What is the relative path to the template?',
					when: function(answers) {
						return answers.has_partial_template;
					}
				}
			]);
			params.class_name = answers.class_name;
			params.is_acf_compatible = answers.is_acf_compatible;
			params.has_partial_template = answers.has_partial_template;
			params.partial_template_path = answers.partial_template_path;
			question = 2;	

		} else if(question == 2) {

			let answers = await inquirer.prompt([
				{
					type: 'input',
					name: 'name',
					message: 'Whats the name of this property?'
				},
				{
					type: 'list',
					name: 'type',
					message: 'What type of property is this?',
					choices: [
						'array',
						'boolean',
						'object',
						'string'
					],
					default: 'string'
				},
				{
					type: 'input',
					name: 'description',
					message: 'Briefly describe the property'
				},
				{
					type: 'confirm',
					name: 'required',
					message: 'Is this property required?'
				},
				{
					type: 'confirm',
					name: 'add_another',
					message: 'Would you like to add another?'
				}
			]);

			params.properties.push(answers);

			if(!answers.add_another) {
				question = false;
			}
		}
	}
	
	var output = mustache.render(data, params);

	const theme = await wordpress.getActiveTheme();

	const themeDir = await wordpress.pathToThemesDir + '/' + theme.name;
	const fileName = 'class-' + params.class_name.toLowerCase().replace('_','-');
	const filePath = themeDir + '/src/partials/' + fileName + '.php';

	await sh.exec(`cat > ${filePath} <<EOF
${output}`);


}