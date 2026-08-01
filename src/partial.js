import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';
import * as core from './core.js';
import inquirer from 'inquirer';
import mustache from 'mustache';
import * as wordpress from './wordpress.js';
import {
	isValidClassName,
	isValidTemplateName,
	isValidPropType,
	parsePropFlag,
	classNameToFileSlug,
	classNameToSlug,
	humanizeClassName,
	defaultTemplateName,
	PROP_TYPES,
	PROP_TYPE_TO_BLOCK,
} from './validate.js';

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
 * Create a new "partial".
 *
 * Flag-driven first: if --json or --name is provided the partial is created
 * headlessly; otherwise the interactive wizard collects the same params. Both
 * paths converge on writePartial() so their output is identical.
 **/
export async function create(args) {

	const dir = args['--dir'] ? args['--dir'] : '.';
	process.chdir(dir);

	if (! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

	// Resolve the target theme directory. --theme skips the WP lookup (and lets
	// the op run headlessly without a configured database); otherwise fall back
	// to the currently active theme.
	let themeName;
	if (args['--theme']) {
		themeName = args['--theme'];
	} else {
		const theme = await wordpress.getActiveTheme();
		if (!theme) {
			log.error('Could not determine the active theme. Pass --theme <name> to specify one.');
			return false;
		}
		themeName = theme.name;
	}
	const themeDir = wordpress.pathToThemesDir + '/' + themeName;

	// Gather params: --json, then --name (flags), else the interactive wizard.
	let params;
	try {
		if (args['--json']) {
			params = paramsFromJson(args['--json']);
		} else if (args['--name']) {
			params = paramsFromFlags(args);
		} else {
			params = await runWizard(themeDir);
		}
		validateParams(params);
	} catch (err) {
		log.error(err.message);
		return false;
	}

	writePartial(params, themeDir);
	return true;
}

/**
 * Build params from CLI flags (--name, --prop, --acf, --no-template, ...).
 **/
export function paramsFromFlags(args) {
	const className = args['--name'];
	return {
		class_name: className,
		is_acf_compatible: !!args['--acf'],
		has_partial_template: !args['--no-template'],
		partial_template_name: args['--template-name'] || defaultTemplateName(className),
		properties: (args['--prop'] || []).map(parsePropFlag),
		emit: {
			block: !args['--no-block'],
			style: !args['--no-style'],
			manifest: !args['--no-manifest'],
		},
	};
}

/**
 * Build params from a --json value: `@path/to/file.json` or an inline JSON
 * string, matching the canonical partial contract.
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

	const className = spec.name;
	return {
		class_name: className,
		is_acf_compatible: !!spec.acf_compatible,
		has_partial_template: spec.template !== false,
		partial_template_name: spec.template_name || (className ? defaultTemplateName(className) : ''),
		properties: (spec.properties || []).map((p) => ({
			name: p.name,
			type: p.type,
			required: !!p.required,
			description: p.description || '',
		})),
		emit: {
			block: spec.block !== false,
			style: spec.style !== false,
			manifest: spec.manifest !== false,
		},
	};
}

/**
 * Validate a fully-assembled params object. Throws with a clear message.
 **/
export function validateParams(params) {
	if (!params.class_name || !isValidClassName(params.class_name)) {
		throw new Error(`Invalid class name "${params.class_name || ''}". Must be WordPress snake-case, e.g. Example_Class.`);
	}
	if (params.has_partial_template && !isValidTemplateName(params.partial_template_name)) {
		throw new Error(`Invalid template name "${params.partial_template_name}". Use lowercase letters and dashes ending in .php, e.g. my-template.php.`);
	}
	for (const p of params.properties) {
		if (!p.name) {
			throw new Error('Every property must have a name.');
		}
		if (!isValidPropType(p.type)) {
			throw new Error(`Invalid property type "${p.type}" for property "${p.name}". Valid types: ${PROP_TYPES.join(', ')}.`);
		}
	}
}

/**
 * Render and write the partial class (and optional view template).
 * Pure execution: no prompts, no network. Given identical params + themeDir it
 * produces identical output whether called from the flag path or the wizard.
 **/
export function writePartial(params, themeDir) {

	const partialTemplatePath = './partials/' + params.partial_template_name;

	// The class
	const classTemplate = fs.readFileSync(new URL('./templates/partial.class.mustache', import.meta.url), 'utf8');
	const classOutput = mustache.render(classTemplate, {
		class_name: params.class_name,
		is_acf_compatible: params.is_acf_compatible,
		has_partial_template: params.has_partial_template,
		partial_template_path: partialTemplatePath,
		properties: params.properties,
	});
	const classFilePath = `${themeDir}/src/partials/${classNameToFileSlug(params.class_name)}.php`;
	fs.ensureDirSync(path.dirname(classFilePath));
	fs.writeFileSync(classFilePath, classOutput);
	log.success(`Partial class created at: ${classFilePath}`);

	// The view template (optional)
	if (params.has_partial_template && params.partial_template_name) {
		const viewTemplate = fs.readFileSync(new URL('./templates/partial.template.mustache', import.meta.url), 'utf8');
		const viewName = params.partial_template_name.replace('.php', '');
		const viewOutput = mustache.render(viewTemplate, {
			template_class_name: viewName,
			template_name: viewName,
		});
		const viewFilePath = `${themeDir}/partials/${params.partial_template_name}`;
		fs.ensureDirSync(path.dirname(viewFilePath));
		fs.writeFileSync(viewFilePath, viewOutput);
		log.success(`View template created at: ${viewFilePath}`);
	}

	// The spine's additional outputs — all derived from the same params.
	const slug = classNameToSlug(params.class_name);
	const emit = params.emit || {};

	// block.json (FSE half) — attributes derived from the properties.
	if (emit.block !== false) {
		const attributes = {};
		for (const p of params.properties) {
			attributes[p.name] = { type: PROP_TYPE_TO_BLOCK[p.type] || 'string' };
		}
		const block = {
			$schema: 'https://schemas.wp.org/trunk/block.json',
			apiVersion: 3,
			name: `wonderpress/${slug}`,
			title: humanizeClassName(params.class_name),
			category: 'wonderpress',
			attributes,
		};
		const blockPath = `${themeDir}/blocks/${slug}/block.json`;
		fs.ensureDirSync(path.dirname(blockPath));
		fs.writeFileSync(blockPath, JSON.stringify(block, null, 2) + '\n');
		log.success(`Block metadata created at: ${blockPath}`);
	}

	// Static Kit style stub (styling half) — tokens only; styles the view wrapper.
	if (emit.style !== false && params.has_partial_template) {
		const styleTemplate = fs.readFileSync(new URL('./templates/partial.style.mustache', import.meta.url), 'utf8');
		const styleOutput = mustache.render(styleTemplate, {
			name: humanizeClassName(params.class_name),
			slug,
		});
		const stylePath = `${themeDir}/static/src/scss/partials/_${slug}.scss`;
		fs.ensureDirSync(path.dirname(stylePath));
		fs.writeFileSync(stylePath, styleOutput);
		log.success(`Style stub created at: ${stylePath}`);
		log.info(`Remember to \`@use 'partials/${slug}'\` from a Static Kit entry (e.g. single.scss) to compile it.`);
	}

	// Agent-readable manifest (AI half) — the contract + artifact paths.
	if (emit.manifest !== false) {
		const artifacts = {
			class: `src/partials/${classNameToFileSlug(params.class_name)}.php`,
		};
		if (params.has_partial_template) {
			artifacts.view = `partials/${params.partial_template_name}`;
		}
		if (emit.block !== false) {
			artifacts.block = `blocks/${slug}/block.json`;
		}
		if (emit.style !== false && params.has_partial_template) {
			artifacts.style = `static/src/scss/partials/_${slug}.scss`;
		}
		const manifest = {
			name: params.class_name,
			slug,
			block: `wonderpress/${slug}`,
			acf_compatible: params.is_acf_compatible,
			properties: params.properties,
			artifacts,
		};
		const manifestPath = `${themeDir}/.wonderpress/manifest/${slug}.json`;
		fs.ensureDirSync(path.dirname(manifestPath));
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
		log.success(`Manifest created at: ${manifestPath}`);
	}
}

/**
 * Interactive wizard — a thin convenience wrapper that collects the same
 * params the flags would, then returns them for writePartial().
 **/
async function runWizard(themeDir) {

	log.info('Starting partial creation wizard...');
	log.instructions('In Wonderpress, a "partial" is a PHP class that helps render a reusable view. Here we will create the PHP class (and optionally the PHP template for the view). Please answer the following questions:');

	const step1 = await inquirer.prompt([
		{
			type: 'input',
			name: 'class_name',
			message: 'What should we name this class?',
			suffix: '\nAccording to WordPress standards, the class name must be in snake-case format:',
			validate: function (answer) {
				const valid = isValidClassName(answer);
				if (!valid) {
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
			suffix: `\nThis file will be created in ${themeDir}/partials`,
			default: true
		},
		{
			type: 'input',
			name: 'partial_template_name',
			message: 'What should we name the view template?',
			default: function (answers) {
				return defaultTemplateName(answers.class_name);
			},
			when: function (answers) {
				return answers.has_partial_template;
			},
			validate: function (input) {
				const valid = isValidTemplateName(input);
				if (!valid) {
					log.info('');
					log.error('Please only use lowercase characters and dashes, and make sure the name ends with .php');
					log.info('Here\'s an example: my-template-name.php');
				}
				return valid;
			}
		}
	]);

	const properties = [];
	let addAnother = true;
	while (addAnother) {

		if (!properties.length) {
			log.instructions('Time to configure the properties for this partial. Properties are values that may be passed into the partial class during instantiation, and these values will be validated and passed to the view template for display.');
		}

		const addMessage = properties.length ? 'Would you like to define another property for this partial?' : 'Would you like to define a property for this partial?';

		const answers = await inquirer.prompt([
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
				when: function (answers) {
					return answers.add_another;
				}
			},
			{
				type: 'list',
				name: 'type',
				message: 'What type of property is this?',
				suffix: '\nWonderpress will validate this property accordingly when rendering:',
				choices: PROP_TYPES,
				default: 'string',
				when: function (answers) {
					return answers.add_another;
				}
			},
			{
				type: 'input',
				name: 'description',
				message: 'Briefly describe the property',
				suffix: '\nThis will help developers understand its purpose:',
				when: function (answers) {
					return answers.add_another;
				}
			},
			{
				type: 'confirm',
				name: 'required',
				message: 'Should this property be validated as required?',
				suffix: '\nIf "yes", then Wonderpress will enforce a value upon instantiation:',
				when: function (answers) {
					return answers.add_another;
				}
			}
		]);

		if (!answers.add_another) {
			log.info('Property configuration is complete. Moving on...');
			addAnother = false;
		} else {
			properties.push({
				name: answers.name,
				type: answers.type,
				required: answers.required,
				description: answers.description || '',
			});
		}
	}

	return {
		class_name: step1.class_name,
		is_acf_compatible: step1.is_acf_compatible,
		has_partial_template: step1.has_partial_template,
		partial_template_name: step1.has_partial_template ? step1.partial_template_name : defaultTemplateName(step1.class_name),
		properties,
		emit: { block: true, style: true, manifest: true },
	};
}
