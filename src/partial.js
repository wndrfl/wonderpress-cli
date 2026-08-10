import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';
import * as core from './core.js';
import inquirer from 'inquirer';
import mustache from 'mustache';
import * as staticCli from '@wndrfl/static-kit-cli';
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
	isSafeSlug,
	nameToSlug,
	resolveWithin,
	slugToPascal,
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
		case 'list':
			await list(args);
			break;
		case 'remove':
			await remove(args);
			break;
	}

	return true;
}

/**
 * Resolve the theme directory a command operates on, after moving the cwd to
 * the environment root.
 *
 * --theme skips the WordPress lookup (and so lets the op run headlessly without
 * a configured database); otherwise the currently active theme wins. Returns
 * false when the environment or the theme could not be resolved.
 **/
export async function resolveThemeDir(args) {

	const dir = args['--dir'] ? args['--dir'] : '.';
	process.chdir(dir);

	if (! await core.setCwdToEnvironmentRoot()) {
		return false;
	}

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

	return wordpress.pathToThemesDir + '/' + themeName;
}

/**
 * Create a new "partial".
 *
 * Flag-driven first: if --json or --name is provided the partial is created
 * headlessly; otherwise the interactive wizard collects the same params. Both
 * paths converge on writePartial() so their output is identical.
 **/
export async function create(args) {

	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

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

	await writePartial(params, themeDir);
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
			// A partial is not a block. block.json + register_block_type is a
			// formal Gutenberg registration, so it's opt-IN — only partials you
			// explicitly want in the editor carry it.
			block: !!args['--block'],
			manifest: !args['--no-manifest'],
			style: !args['--no-style'],
			// Most partials have no behavior, so the JS half is opt-IN too: the
			// file's existence is itself the signal that this one does.
			script: !!args['--js'],
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
			// Opt-in (see paramsFromFlags): a block is only emitted when the
			// spec explicitly asks for it.
			block: spec.block === true,
			manifest: spec.manifest !== false,
			style: spec.style !== false,
			// Opt-in as well; `script` is accepted as an alias of `js`.
			script: spec.js === true || spec.script === true,
		},
	};
}

/**
 * Reconstruct a params object from a manifest file's contents.
 *
 * The manifest is the CLI's index of what a theme contains, so retrofitting a
 * block onto an existing partial (`block create`) reads the original contract
 * back from here instead of asking the user to restate it. The manifest records
 * the view by path rather than by name, so the template name is derived from
 * `artifacts.view`.
 **/
export function paramsFromManifest(manifest) {

	if (!manifest || !manifest.name) {
		throw new Error('Could not read a component name from the manifest.');
	}

	const artifacts = manifest.artifacts || {};
	const hasView = !!artifacts.view;

	return {
		class_name: manifest.name,
		is_acf_compatible: !!manifest.acf_compatible,
		has_partial_template: hasView,
		partial_template_name: hasView ? path.basename(artifacts.view) : defaultTemplateName(manifest.name),
		properties: manifest.properties || [],
		emit: {
			block: !!manifest.block,
			manifest: true,
			// Reflect what the manifest says was actually written, so a rewrite
			// never invents (or drops) a delegated artifact.
			style: !!artifacts.style,
			script: !!artifacts.script,
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

	// A block that is not in the index is unmanageable: `block list`,
	// `block remove`, and `partial remove` all read the manifest, so a block
	// written without one is an orphan nothing can find again.
	const emit = params.emit || {};
	if (emit.block && emit.manifest === false) {
		throw new Error('A block requires the manifest (it is the index that makes the block manageable). Drop --no-manifest or --block.');
	}
}

/**
 * Render and write the partial class (and optional view template).
 * Pure execution: no prompts, no network. Given identical params + themeDir it
 * produces identical output whether called from the flag path or the wizard.
 **/
export async function writePartial(params, themeDir) {

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

	// Neither delegated half is meaningful for a partial that renders no view,
	// so `--js --no-template` gets nothing. Say so rather than swallowing it.
	if (emit.script === true && !params.has_partial_template) {
		log.warn(`Skipped the JS behavior class for "${slug}": a behavior stub is only emitted for partials that render a view template. Drop --no-template if this partial needs client-side JS.`);
	}

	// The style/behavior halves are delegated to Static Kit's `component.create`.
	// That API only exists in newer static-kit-cli builds; a theme may have an
	// older published version installed. Detect it up front so we never crash on
	// a missing API and never record an artifact we did not actually write.
	const componentApiAvailable = !!(staticCli.component && typeof staticCli.component.create === 'function');
	const { wantsStyle, wantsScript, willEmitStyle, willEmitScript } = staticArtifacts(params, componentApiAvailable);

	// Delegate FIRST, then record. `component.create` silently no-ops when the
	// static tree has no config (no `.staticrc`) or no src path for a half, so
	// asking for it is not evidence that it landed — only the file on disk is.
	//
	// `static/` is a Static-Kit-installed tree, so we delegate to Static Kit —
	// which owns the location/format — instead of writing into it directly (same
	// pattern as `template create` calling `staticCli.template.create`).
	if (willEmitStyle || willEmitScript) {
		await staticCli.component.create(`${themeDir}/static`, slug, {
			style: willEmitStyle,
			script: willEmitScript,
		});
	}

	// Existence is the source of truth for the delegated halves.
	//
	// TODO (cross-repo, not this PR): static-kit's `component.create` should
	// return the paths it actually wrote, and the CLI should record those. Until
	// it does we can only probe Static Kit's DEFAULT layout, so a theme with
	// custom `.staticrc` src paths writes real files at paths we cannot see —
	// conservatively recorded as "not written" rather than recorded wrongly.
	const staticPaths = staticArtifactPaths(slug);
	const wroteStyle = wantsStyle && fs.existsSync(`${themeDir}/${staticPaths.style}`);
	const wroteScript = wantsScript && fs.existsSync(`${themeDir}/${staticPaths.script}`);

	const skipped = [!wroteStyle && wantsStyle ? 'style stub' : null, !wroteScript && wantsScript ? 'JS behavior class' : null].filter(Boolean).join(' and ');
	if (skipped) {
		const why = componentApiAvailable
			? 'Static Kit wrote nothing at the expected default path — the theme has no configured static tree (`static/.staticrc`), or uses a custom src layout'
			: 'the installed @wndrfl/static-kit-cli has no component.create API — upgrade Static Kit to enable per-partial static assets';
		log.warn(`Skipped the ${skipped} for "${slug}": ${why}. It is not recorded in the manifest; the partial, block, and manifest were still written.`);
	}

	// block.json (opt-in editor wrapper) — a partial is NOT a block, so this is
	// only emitted when explicitly requested.
	if (emit.block) {
		writeBlock(params, themeDir);
	}

	// Agent-readable manifest (AI half) — the contract + the artifacts that
	// actually exist.
	if (emit.manifest !== false) {
		writeManifest(params, themeDir, { style: wroteStyle, script: wroteScript });
	}
}

/**
 * The default paths Static Kit writes a component's delegated halves to,
 * relative to the theme directory.
 *
 * Kept in lockstep with `staticCli.component.create` so writePartial can probe
 * for what landed and writeManifest can record it — both from one definition.
 **/
export function staticArtifactPaths(slug) {
	return {
		style: `static/src/scss/partials/_${slug}.scss`,
		script: `static/src/js/lib/partials/${slugToPascal(slug)}.js`,
	};
}

/**
 * Decide which delegated (Static Kit) halves a set of params should produce.
 *
 * Both halves come from the same `component.create` API, so both are gated on
 * that API being present in the installed static-kit-cli build — and neither is
 * meaningful for a partial that renders no view.
 **/
export function staticArtifacts(params, apiAvailable) {

	const emit = params.emit || {};
	const wantsStyle = !!params.has_partial_template && emit.style !== false;
	const wantsScript = !!params.has_partial_template && emit.script === true;

	return {
		wantsStyle,
		wantsScript,
		willEmitStyle: wantsStyle && !!apiAvailable,
		willEmitScript: wantsScript && !!apiAvailable,
	};
}

/**
 * Write a partial's opt-in Gutenberg wrapper: `block.json` plus the `render.php`
 * that delegates the block's server render back to the partial.
 *
 * A block is definitionally a thin wrapper over a partial — it never carries
 * markup of its own — so this is the single code path behind both
 * `partial create --block` and `block create`.
 **/
export function writeBlock(params, themeDir) {

	const slug = classNameToSlug(params.class_name);

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
		render: 'file:./render.php',
	};
	const blockDir = `${themeDir}/blocks/${slug}`;
	fs.ensureDirSync(blockDir);
	fs.writeFileSync(`${blockDir}/block.json`, JSON.stringify(block, null, 2) + '\n');
	log.success(`Block metadata created at: ${blockDir}/block.json`);

	// Server render: delegate to the partial (block == partial-in-the-editor).
	const renderTemplate = fs.readFileSync(new URL('./templates/block.render.mustache', import.meta.url), 'utf8');
	const renderOutput = mustache.render(renderTemplate, {
		slug,
		class_name: params.class_name,
	});
	fs.writeFileSync(`${blockDir}/render.php`, renderOutput);
	log.success(`Block render created at: ${blockDir}/render.php`);

	return blockDir;
}

/**
 * Write the agent-readable manifest — the component's contract plus the paths of
 * the artifacts that were ACTUALLY written.
 *
 * `written` reports which delegated halves landed, so the manifest never
 * advertises a file that does not exist. Every writer goes through here, which
 * is what keeps `partial create --block` and `partial create` + `block create`
 * byte-identical.
 **/
export function writeManifest(params, themeDir, written = {}) {

	const slug = classNameToSlug(params.class_name);
	const emit = params.emit || {};

	const artifacts = {
		class: `src/partials/${classNameToFileSlug(params.class_name)}.php`,
	};
	if (params.has_partial_template) {
		artifacts.view = `partials/${params.partial_template_name}`;
	}
	if (emit.block) {
		artifacts.block = `blocks/${slug}/block.json`;
		artifacts.render = `blocks/${slug}/render.php`;
	}
	const staticPaths = staticArtifactPaths(slug);
	if (written.style) {
		artifacts.style = staticPaths.style;
	}
	if (written.script) {
		artifacts.script = staticPaths.script;
	}

	const manifest = {
		name: params.class_name,
		slug,
		// Only a partial that opted in to being a block advertises one.
		...(emit.block ? { block: `wonderpress/${slug}` } : {}),
		acf_compatible: params.is_acf_compatible,
		properties: params.properties,
		artifacts,
	};

	const file = manifestPath(themeDir, slug);
	fs.ensureDirSync(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
	log.success(`Manifest created at: ${file}`);

	return file;
}

/**
 * Path to a component's manifest file within a theme.
 **/
export function manifestPath(themeDir, slug) {
	return `${themeDir}/.wonderpress/manifest/${slug}.json`;
}

/**
 * Whether a parsed manifest is shaped like the index entry the CRUD commands
 * assume. Everything downstream derives paths from `name`/`slug`, so a file
 * that has neither (`[]`, `null`, a bare number) is not a manifest at all.
 **/
export function isValidManifest(manifest) {
	return !!manifest
		&& typeof manifest === 'object'
		&& !Array.isArray(manifest)
		&& typeof manifest.name === 'string' && !!manifest.name
		&& typeof manifest.slug === 'string' && !!manifest.slug;
}

/**
 * Read a single manifest by slug. Returns null when the component is unknown,
 * or when the file on disk is not a usable manifest.
 **/
export function readManifest(themeDir, slug) {

	const file = manifestPath(themeDir, slug);
	if (!fs.existsSync(file)) {
		return null;
	}

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		log.error(`Could not parse the manifest at ${file}: ${e.message}`);
		return null;
	}

	if (!isValidManifest(manifest)) {
		log.error(`The manifest at ${file} is malformed: it must be an object with string "name" and "slug" fields. Fix or delete it.`);
		return null;
	}

	return manifest;
}

/**
 * Read every manifest in a theme, sorted by slug.
 *
 * `.wonderpress/manifest/` is the CLI's index — `list` and `remove` read it
 * rather than scanning (and guessing at) source files.
 **/
export function readManifests(themeDir) {

	const dir = `${themeDir}/.wonderpress/manifest`;
	if (!fs.existsSync(dir)) {
		return [];
	}

	return fs.readdirSync(dir)
		.filter((file) => file.endsWith('.json'))
		.sort()
		.map((file) => {
			let manifest;
			try {
				manifest = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			} catch (e) {
				log.warn(`Skipping unreadable manifest ${file}: ${e.message}`);
				return null;
			}

			if (!isValidManifest(manifest)) {
				log.warn(`Skipping malformed manifest ${file}: expected an object with string "name" and "slug" fields.`);
				return null;
			}

			return manifest;
		})
		.filter(Boolean);
}

/**
 * Delete a block's directory. Returns whether anything was there to remove.
 *
 * This is a recursive delete, so the directory is resolved through
 * `resolveWithin` — a slug is user-derived, and no removal may ever land
 * outside the theme.
 **/
export function removeBlockDir(themeDir, slug) {

	const blockDir = resolveWithin(themeDir, `blocks/${slug}`);
	if (!blockDir) {
		log.error(`Refusing to remove "blocks/${slug}": that path escapes the theme directory.`);
		return false;
	}

	if (!fs.existsSync(blockDir)) {
		return false;
	}

	fs.removeSync(blockDir);
	log.success(`Block removed: ${blockDir}`);
	return true;
}

/**
 * Rows for `partial list`, read from the manifest index.
 **/
export function listPartials(themeDir) {
	return readManifests(themeDir).map((manifest) => ({
		name: manifest.name,
		slug: manifest.slug,
		block: manifest.block || null,
	}));
}

/**
 * List every partial the manifest index knows about.
 **/
export async function list(args) {

	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

	const rows = listPartials(themeDir);
	if (!rows.length) {
		log.info(`No partials found in ${themeDir}. Create one with \`wonderpress partial create --name <Name>\`.`);
		return true;
	}

	log.table(['NAME', 'SLUG', 'BLOCK'], rows.map((row) => [row.name, row.slug, row.block || '—']));
	log.info(`${rows.length} partial${rows.length === 1 ? '' : 's'}.`);
	return true;
}

/**
 * Delete a partial and everything the manifest says was written for it.
 *
 * A block cannot exist without its partial, so removing a partial that is
 * wrapped by one is refused unless `withBlock` is set — that refusal is the
 * safety here (this is a flag-driven headless tool, so there are no prompts).
 **/
export function removePartial(themeDir, name, options = {}) {

	// The user's input only locates the manifest; a name that cannot be a
	// filesystem-safe slug is refused outright rather than resolved.
	const lookupSlug = nameToSlug(name);
	if (!isSafeSlug(lookupSlug)) {
		log.error(`Invalid partial name "${name}". A component name resolves to a slug of lowercase letters, numbers, and dashes.`);
		return false;
	}

	const manifest = readManifest(themeDir, lookupSlug);
	if (!manifest) {
		log.error(`No partial named "${name}" is recorded in this theme. Run \`wonderpress partial list\` to see what exists.`);
		return false;
	}

	// The manifest is authoritative about its own identity, so every derived
	// path comes from `manifest.slug` rather than from what the user typed.
	const slug = manifest.slug;
	if (!isSafeSlug(slug)) {
		log.error(`The manifest for "${name}" records an unusable slug "${slug}". Fix the manifest before removing this partial.`);
		return false;
	}

	if (manifest.block && !options.withBlock) {
		log.error(`This partial is wrapped by block ${manifest.block}. Run \`wonderpress block remove ${manifest.name}\` first, or pass --with-block.`);
		return false;
	}

	// The manifest is the record of what was written, so it is also the
	// deletion list — we never guess at paths. It is also just a file on disk,
	// so every entry is resolved back inside the theme before anything is
	// deleted; one bad entry is skipped rather than aborting the removal.
	const artifacts = manifest.artifacts || {};
	for (const key of ['class', 'view', 'style', 'script']) {
		if (!artifacts[key]) {
			continue;
		}

		const file = resolveWithin(themeDir, artifacts[key]);
		if (!file) {
			log.error(`Refusing to remove ${key} "${artifacts[key]}": that path escapes the theme directory. Skipping it.`);
			continue;
		}

		if (fs.existsSync(file)) {
			fs.removeSync(file);
			log.success(`Removed ${key}: ${file}`);
		} else {
			// Nothing to delete is not the same as nothing was there: a theme with
			// a custom `.staticrc` layout can have real files the manifest cannot
			// name (see the TODO in writePartial).
			log.warn(`Nothing to remove for ${key}: ${file} does not exist. If this theme uses a custom static layout, check for an orphaned file by hand.`);
		}
	}

	if (manifest.block) {
		removeBlockDir(themeDir, slug);
	}

	const file = resolveWithin(themeDir, `.wonderpress/manifest/${slug}.json`);
	if (!file) {
		log.error(`Refusing to remove the manifest for "${slug}": that path escapes the theme directory.`);
		return false;
	}

	fs.removeSync(file);
	log.success(`Removed manifest: ${file}`);
	return true;
}

/**
 * Remove a partial (`partial remove <Name>`).
 **/
export async function remove(args) {

	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

	const name = args._ && args._[2] ? args._[2] : args['--name'];
	if (!name) {
		log.error('No name provided. Usage: wonderpress partial remove <Name>.');
		return false;
	}

	return removePartial(themeDir, name, { withBlock: !!args['--with-block'] });
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
		},
		{
			type: 'confirm',
			name: 'emit_script',
			message: 'Also scaffold a JS behavior class for this partial?',
			suffix: '\nMost partials have no behavior; say "N" unless this one needs client-side JS:',
			default: false,
			when: function (answers) {
				return answers.has_partial_template;
			}
		},
		{
			type: 'confirm',
			name: 'emit_block',
			message: 'Also expose this partial as a Gutenberg block?',
			suffix: '\nMost partials are compositional and should not be blocks; say "N" unless you want it in the editor:',
			default: false,
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
		emit: { block: !!step1.emit_block, manifest: true, style: true, script: !!step1.emit_script },
	};
}
