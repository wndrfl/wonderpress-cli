import fs from 'fs-extra';
import path from 'path';
import * as help from './help.js';
import * as format from './format.js';
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
	parseSubFlag,
	normalizeProperty,
	phpFormatForType,
	classNameToFileSlug,
	classNameToSlug,
	humanizeClassName,
	defaultTemplateName,
	isSafeSlug,
	nameToSlug,
	resolveWithin,
	slugToPascal,
	isValidNamespace,
	PROP_TYPES,
	PROP_TYPE_TO_BLOCK,
	REPEATER_SUB_TYPES,
	assertDualAuthorable,
	LEGACY_NAMESPACE,
	validateManifestProperty,
	partialManifestPath,
	PARTIAL_MANIFEST_DIR,
} from './validate.js';
import * as config from './config.js';
import { pickOne, canAsk } from './prompt.js';
import {
	CORE_PARTIAL_MANIFEST_SLUGS,
	installCorePartialManifest,
	resolveCoreBundledPartialManifest,
} from './partial-manifests.js';
import { checkPartialDrift } from './partial-drift.js';

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
		case 'install-manifest':
			await installManifest(args);
			break;
		case 'sync':
			await sync(args);
			break;
		case 'check-drift':
			await checkDrift(args);
			break;
		case 'add-js':
			await addJs(args);
			break;
		default:
			// No subcommand (or an unrecognised one) means the user is looking for
			// the shape of this command group, not silence.
			if (subcommand) {
				log.error(`Unknown partial subcommand: ${subcommand}`);
				process.exitCode = format.EXIT_FAIL;
				format.fail({
					code: 'unknown_command',
					message: `Unknown partial subcommand: ${subcommand}`,
					hint: 'Run `wonderpress partial help`.',
				});
			}
			help.show('partial');
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

async function refreshAgents(themeDir) {
	try {
		const agents = await import('./agents.js');
		agents.writeAgentFiles({ root: process.cwd(), themeDir });
	} catch (err) {
		log.warn(`Could not refresh AGENTS.md: ${err.message}`);
	}
}

/**
 * Determine the block namespace this project publishes under.
 *
 * A block's namespace is not cosmetic: WordPress writes it into the client's
 * content as `<!-- wp:acme/testimonial -->`, so changing it later orphans every
 * block already placed on every page. It therefore belongs to the *project*,
 * not to the tool that generated it, and once a project has one it must never
 * drift.
 *
 * Precedence, most authoritative first:
 *
 *   1. `namespace` in .wonderpressrc — an explicit decision, recorded at init.
 *   2. The namespace already used by this theme's blocks, read off the
 *      manifest index. A project that predates this setting self-describes,
 *      so upgrading the CLI cannot silently re-namespace its content.
 *   3. The theme slug — a project that has neither is naming itself.
 *
 * Only if all three are unavailable does it fall back to the tool's own name.
 **/
export function resolveNamespace(themeDir, root = process.cwd()) {

	const recorded = config.read(root).data.namespace;
	if (isValidNamespace(recorded)) {
		return recorded;
	}

	for (const manifest of readManifests(themeDir)) {
		const existing = (manifest.block || '').split('/')[0];
		if (isValidNamespace(existing)) {
			return existing;
		}
	}

	const themeSlug = path.basename(themeDir || '');
	if (isValidNamespace(themeSlug)) {
		return themeSlug;
	}

	return LEGACY_NAMESPACE;
}

/**
 * The namespace a write should use.
 *
 * Falls back to resolving from the project rather than to a constant. An
 * earlier version defaulted straight to LEGACY_NAMESPACE, which meant any
 * caller that forgot to set params.namespace silently wrote `wonderpress/foo`
 * into a project whose blocks are `acme/foo` — the exact split-namespace
 * failure this machinery exists to prevent, delivered quietly.
 *
 * resolveNamespace() ends at LEGACY_NAMESPACE itself, so the last resort is
 * unchanged; it is just no longer reachable by accident.
 **/
function namespaceFor(params, themeDir) {
	return isValidNamespace(params.namespace) ? params.namespace : resolveNamespace(themeDir);
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

	// A positional name works, because `block create <Name>` has always taken
	// one and there is no reason for two commands in the same CLI to disagree.
	// `partial create Hero` used to fall through to the wizard, which then asked
	// for the name that had just been typed.
	const name = (args._ && args._[2]) || args['--name'];

	// Gather params: --json, then a name (flags), else the interactive wizard.
	let params;
	try {
		if (args['--json']) {
			params = paramsFromJson(args['--json']);
		} else if (name) {
			params = paramsFromFlags({ ...args, '--name': name });
		} else {
			if (!canAsk(args)) {
				log.error('No name provided. Usage: wonderpress partial create --name <Name> (or --json @spec.json).');
				return format.fail({
					code: 'usage',
					message: 'partial create requires --name, --json, or an interactive TTY',
					hint: 'wonderpress partial create --name Hero --prop title:string',
				}, format.EXIT_USAGE);
			}
			params = await runWizard(themeDir, args);
		}
		validateParams(params, themeDir);
	} catch (err) {
		log.error(err.message);
		return format.fail({ code: 'validation', message: err.message });
	}

	// The namespace is a property of the project, not of this invocation, so it
	// is resolved from the project rather than gathered with the other params.
	params.namespace = resolveNamespace(themeDir);

	await writePartial(params, themeDir);
	await refreshAgents(themeDir);
	if (format.isJson()) {
		return format.ok({
			name: params.class_name,
			slug: classNameToSlug(params.class_name),
			block: params.emit.block ? `${params.namespace}/${classNameToSlug(params.class_name)}` : null,
		});
	}
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
		properties: attachSubFields((args['--prop'] || []).map(parsePropFlag), args['--sub'] || []),
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
 * Attach --sub rows onto the matching repeater properties.
 **/
export function attachSubFields(properties, subs = []) {
	if (!subs.length) {
		return properties;
	}

	const names = new Map(properties.map((p) => [p.name, p]));
	const byParent = {};
	for (const raw of subs) {
		const parsed = parseSubFlag(raw);
		const parent = names.get(parsed.parent);
		if (!parent) {
			throw new Error(`--sub refers to unknown property "${parsed.parent}".`);
		}
		if (parent.type !== 'repeater') {
			throw new Error(`--sub parent "${parsed.parent}" is type "${parent.type}", not repeater.`);
		}
		if (!byParent[parsed.parent]) {
			byParent[parsed.parent] = [];
		}
		byParent[parsed.parent].push({
			name: parsed.name,
			type: parsed.type,
			required: parsed.required,
			description: parsed.description,
		});
	}

	return properties.map((p) => {
		if (p.type !== 'repeater') {
			return p;
		}
		const extra = byParent[p.name] || [];
		return { ...p, properties: [ ...(p.properties || []), ...extra ] };
	});
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
		properties: (spec.properties || []).map(normalizeProperty),
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
		properties: (manifest.properties || []).map(normalizeProperty),
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
export function validateParams(params, themeDir = null) {
	if (!params.class_name || !isValidClassName(params.class_name)) {
		throw new Error(`Invalid class name "${params.class_name || ''}". Must be WordPress snake-case, e.g. Example_Class.`);
	}
	if (params.has_partial_template && !isValidTemplateName(params.partial_template_name)) {
		throw new Error(`Invalid template name "${params.partial_template_name}". Use lowercase letters and dashes ending in .php, e.g. my-template.php.`);
	}
	const siblingNames = new Set(params.properties.filter((prop) => prop?.name).map((prop) => prop.name));
	for (const p of params.properties) {
		validateManifestProperty(p, { siblingNames });
	}

	if (params.acf?.location) {
		throw new Error(
			'Partial manifests no longer support acf.location. Locate the field group via template composition or the wonderpress_template_fields filter.',
		);
	}

	// A block that is not in the index is unmanageable: `block list`,
	// `block remove`, and `partial remove` all read the manifest, so a block
	// written without one is an orphan nothing can find again.
	const emit = params.emit || {};
	if (emit.block && emit.manifest === false) {
		throw new Error('A block requires the manifest (it is the index that makes the block manageable). Drop --no-manifest or --block.');
	}

	// An ACF-compatible partial without a manifest cannot register a field
	// group: core reads `.wonderpress/manifest/partials/*.json` on acf/init.
	if (params.is_acf_compatible && emit.manifest === false) {
		throw new Error('ACF compatibility requires the manifest (it is what core reads to register the field group). Drop --no-manifest or --acf.');
	}

	assertDualAuthorable(params, { themeDir });
}

/**
 * Render and write the partial class (and optional view template).
 * Pure execution: no prompts, no network. Given identical params + themeDir it
 * produces identical output whether called from the flag path or the wizard.
 **/
/**
 * Regenerate the partial PHP class from manifest properties ($_properties).
 * Overwrites the class file; custom methods in that file are not preserved.
 *
 * @param {ReturnType<typeof paramsFromManifest>} params
 * @param {string} themeDir
 * @returns {string} Absolute path written.
 */
export function writePartialClass(params, themeDir) {
	const partialTemplatePath = './partials/' + params.partial_template_name;
	const classTemplate = fs.readFileSync(new URL('./templates/partial.class.mustache', import.meta.url), 'utf8');
	const slug = classNameToSlug(params.class_name);
	const classOutput = mustache.render(classTemplate, {
		class_name: params.class_name,
		is_acf_compatible: params.is_acf_compatible,
		has_partial_template: params.has_partial_template,
		partial_template_path: partialTemplatePath,
		manifest_rel_path: `.wonderpress/manifest/partials/${slug}.json`,
		sync_command: `wonderpress partial sync ${params.class_name}`,
		properties: params.properties.map((p) => ({
			...p,
			format: phpFormatForType(p.type),
		})),
	});
	const classFilePath = `${themeDir}/src/partials/${classNameToFileSlug(params.class_name)}.php`;
	fs.ensureDirSync(path.dirname(classFilePath));
	fs.writeFileSync(classFilePath, classOutput);
	return classFilePath;
}

export async function writePartial(params, themeDir) {

	const classFilePath = writePartialClass(params, themeDir);
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
	// Lazy-load so MCP/read paths never pull sharp at process startup.
	const staticCli = await import('@wndrfl/static-kit-cli');
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
		log.warn(`Skipped the ${skipped} for "${slug}": ${staticSkipReason(componentApiAvailable)}. It is not recorded in the manifest; the partial, block, and manifest were still written.`);
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

function staticSkipReason(apiAvailable) {
	return apiAvailable
		? 'Static Kit wrote nothing at the expected default path — the theme has no configured static tree (`static/.staticrc`), or uses a custom src layout'
		: 'the installed @wndrfl/static-kit-cli has no component.create API — upgrade Static Kit to enable per-partial static assets';
}

/**
 * Scaffold a JS behavior class onto an existing partial and record it.
 *
 * Same retrofit shape as `block create`: the partial already exists, the
 * manifest is the index, and the result is identical to having passed `--js`
 * at creation time. Unlike `block create`, this never overwrites author-owned
 * JS — Static Kit's create always writeFileSyncs.
 **/
export async function addScript(themeDir, name) {

	const lookupSlug = nameToSlug(name);
	if (!isSafeSlug(lookupSlug)) {
		log.error(`Invalid partial name "${name}". A component name resolves to a slug of lowercase letters, numbers, and dashes.`);
		return false;
	}

	const manifest = readManifest(themeDir, lookupSlug);
	if (!manifest) {
		log.error(`No partial named "${name}" is recorded in this theme. A JS behavior class attaches to an existing partial, so create both at once with \`wonderpress partial create --name ${name} --js\`.`);
		return false;
	}

	const artifacts = manifest.artifacts || {};
	const slug = manifest.slug;
	if (!artifacts.view) {
		log.warn(`Skipped the JS behavior class for "${slug}": a behavior stub is only emitted for partials that render a view template.`);
		return false;
	}

	const staticPaths = staticArtifactPaths(slug);
	const recordedRel = artifacts.script;
	const recordedAbs = recordedRel ? `${themeDir}/${recordedRel}` : null;
	const defaultAbs = `${themeDir}/${staticPaths.script}`;
	const recordedExists = !!(recordedAbs && fs.existsSync(recordedAbs));
	const defaultExists = fs.existsSync(defaultAbs);

	if (recordedRel && recordedExists) {
		log.info(`"${manifest.name}" already has a JS behavior class at ${recordedRel}. Import and init it from the page entry that uses this partial.`);
		return true;
	}

	let params;
	try {
		params = paramsFromManifest(manifest);
		params.emit.script = true;
		validateParams(params, themeDir);
	} catch (err) {
		log.error(`Cannot add JS to "${name}": ${err.message}`);
		return false;
	}

	const staticCli = await import('@wndrfl/static-kit-cli');
	const componentApiAvailable = !!(staticCli.component && typeof staticCli.component.create === 'function');

	if (!defaultExists) {
		if (componentApiAvailable) {
			await staticCli.component.create(`${themeDir}/static`, slug, {
				style: false,
				script: true,
			});
		}
	}

	const wroteScript = fs.existsSync(defaultAbs);
	if (!wroteScript) {
		log.warn(`Skipped the JS behavior class for "${slug}": ${staticSkipReason(componentApiAvailable)}. It is not recorded in the manifest.`);
		return false;
	}

	writeManifest(params, themeDir, {
		style: !!artifacts.style,
		script: true,
	});
	log.success(`JS behavior class ready at: ${staticPaths.script}`);
	log.info('This file is not auto-wired. Import and construct it from the page JS entry that renders this partial.');
	return true;
}

/**
 * Add a JS behavior class to an existing partial (`partial add-js <Name>`).
 **/
export async function addJs(args) {

	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

	let name = args._ && args._[2] ? args._[2] : args['--name'];

	if (!name) {
		const manifests = readManifests(themeDir);
		const candidates = manifests.filter((m) => {
			const artifacts = m.artifacts || {};
			return !!artifacts.view && !artifacts.script;
		});

		name = await pickOne({
			message: 'Which partial should get a JS behavior class?',
			choices: candidates.map((p) => ({ name: `${p.name}  (${p.slug})`, value: p.name })),
			empty: manifests.length
				? `Every partial in this theme that has a view already has a JS behavior class (${manifests.length}). Nothing to add.`
				: 'This theme has no partials yet. Create one first: wonderpress partial create <Name> --js',
			usage: 'Usage: wonderpress partial add-js <Name>.',
			args,
		});

		if (!name) {
			return format.fail({
				code: 'usage',
				message: 'partial add-js requires a partial name or an interactive TTY',
				hint: 'wonderpress partial add-js Hero',
			}, format.EXIT_USAGE);
		}
	}

	const ok = await addScript(themeDir, name);
	if (!ok) {
		return format.fail({
			code: 'partial',
			message: `Could not add JS to "${name}"`,
		});
	}

	await refreshAgents(themeDir);

	if (format.isJson()) {
		const slug = nameToSlug(name);
		const manifest = readManifest(themeDir, slug);
		return format.ok({
			name: manifest?.name || name,
			slug: manifest?.slug || slug,
			script: manifest?.artifacts?.script || null,
		});
	}

	return true;
}

/**
 * Write a partial's opt-in Gutenberg wrapper: `block.json` plus the `render.php`
 * that delegates the block's server render back to the partial.
 *
 * A block is definitionally a thin wrapper over a partial — it never carries
 * markup of its own — so this is the single code path behind both
 * `partial create --block` and `block create`.
 **/
/**
 * @param {ReturnType<typeof paramsFromManifest>} params
 * @param {string} themeDir
 * @param {{ skipRender?: boolean }} [options]
 */
export function writeBlock(params, themeDir, options = {}) {

	const slug = classNameToSlug(params.class_name);

	const attributes = {};
	for (const p of params.properties) {
		const attr = { type: PROP_TYPE_TO_BLOCK[p.type] || 'string' };
		if (p.type === 'select' && p.choices && typeof p.choices === 'object' && !Array.isArray(p.choices)) {
			attr.enum = Object.keys(p.choices);
		}
		attributes[p.name] = attr;
	}
	// The project's namespace, not the tool's — see resolveNamespace(). The
	// category rides along with it so the inserter groups a project's blocks
	// under the project rather than under WonderPress.
	const namespace = namespaceFor(params, themeDir);

	const block = {
		$schema: 'https://schemas.wp.org/trunk/block.json',
		apiVersion: 3,
		name: `${namespace}/${slug}`,
		title: humanizeClassName(params.class_name),
		category: namespace,
		attributes,
		render: 'file:./render.php',
	};
	const blockDir = `${themeDir}/blocks/${slug}`;
	fs.ensureDirSync(blockDir);
	fs.writeFileSync(`${blockDir}/block.json`, JSON.stringify(block, null, 2) + '\n');
	log.success(`Block metadata created at: ${blockDir}/block.json`);

	if (!options.skipRender) {
		// Server render: delegate to the partial (block == partial-in-the-editor).
		const renderTemplate = fs.readFileSync(new URL('./templates/block.render.mustache', import.meta.url), 'utf8');
		const renderOutput = mustache.render(renderTemplate, {
			slug,
			namespace,
			class_name: params.class_name,
		});
		fs.writeFileSync(`${blockDir}/render.php`, renderOutput);
		log.success(`Block render created at: ${blockDir}/render.php`);
	}

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
		// Only a partial that opted in to being a block advertises one. The
		// namespace recorded here is what resolveNamespace() later reads back,
		// so a project's first block fixes the namespace for all of them.
		...(emit.block ? { block: `${namespaceFor(params, themeDir)}/${slug}` } : {}),
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
	return partialManifestPath(themeDir, slug);
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
 * `.wonderpress/manifest/partials/` is the CLI's index — `list` and `remove` read it
 * rather than scanning (and guessing at) source files.
 **/
export function readManifests(themeDir) {

	const dir = `${themeDir}/${PARTIAL_MANIFEST_DIR}`;
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
/**
 * Apply manifest contract to derived artifacts (class $_properties, block.json, manifest index).
 *
 * @param {object} manifest Parsed partial manifest.
 * @param {string} themeDir Theme root.
 * @param {{ dryRun?: boolean, propertiesOnly?: boolean }} [options]
 */
export function syncPartialFromManifest(manifest, themeDir, options = {}) {
	const artifacts = manifest.artifacts || {};
	const params = paramsFromManifest(manifest);
	params.namespace = resolveNamespace(themeDir);

	validateParams(params, themeDir);

	const dryRun = !!options.dryRun;
	const propertiesOnly = !!options.propertiesOnly;

	if (dryRun) {
		const slug = classNameToSlug(params.class_name);
		const plan = {
			slug: manifest.slug,
			name: manifest.name,
			properties: params.properties.length,
			files: {
				class: artifacts.class || null,
				block: params.emit.block ? `blocks/${slug}/block.json` : null,
				render: params.emit.block && !propertiesOnly ? `blocks/${slug}/render.php` : null,
				manifest: `${PARTIAL_MANIFEST_DIR}/${manifest.slug}.json`,
			},
		};
		log.info(`Would sync partial class from manifest (${params.properties.length} properties).`);
		if (artifacts.class) {
			log.info(`  class: ${artifacts.class}`);
		}
		if (params.emit.block) {
			log.info(`  block: blocks/${slug}/block.json`);
			if (!propertiesOnly) {
				log.info(`  render: blocks/${slug}/render.php`);
			}
		}
		log.info(`  manifest: ${PARTIAL_MANIFEST_DIR}/${manifest.slug}.json (normalize)`);
		return plan;
	}

	const classPath = writePartialClass(params, themeDir);
	log.success(`Synced partial class: ${classPath}`);

	if (params.emit.block) {
		writeBlock(params, themeDir, { skipRender: propertiesOnly });
		log.success(
			propertiesOnly
				? 'Synced block.json attributes from manifest.'
				: 'Synced block wrapper (block.json + render.php) from manifest.',
		);
	}

	writeManifest(params, themeDir, {
		style: !!artifacts.style,
		script: !!artifacts.script,
	});
	log.success(`Manifest normalized at: ${manifestPath(themeDir, manifest.slug)}`);
	return true;
}

/**
 * Sync derived partial artifacts from `.wonderpress/manifest/partials/*.json`.
 **/
export async function sync(args) {
	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return format.fail({
			code: 'theme',
			message: 'Could not resolve the theme directory',
			hint: 'Pass --theme <name> and --dir <env-root>.',
		});
	}

	const dryRun = args['--dry-run'] === true;
	const propertiesOnly = args['--properties-only'] === true;
	const syncAll = args['--all'] === true;
	const plans = [];

	if (syncAll) {
		const manifests = readManifests(themeDir);
		if (!manifests.length) {
			if (format.isJson()) {
				return format.ok({ synced: [], dryRun });
			}
			log.info(`No partial manifests in ${themeDir}.`);
			return true;
		}
		for (const manifest of manifests) {
			log.info(`Syncing ${manifest.name} (${manifest.slug})...`);
			try {
				const result = syncPartialFromManifest(manifest, themeDir, { dryRun, propertiesOnly });
				if (dryRun && result && result.slug) {
					plans.push(result);
				}
			} catch (err) {
				log.error(`${manifest.slug}: ${err.message}`);
				return format.fail({ code: 'sync', message: `${manifest.slug}: ${err.message}` });
			}
		}
		if (format.isJson()) {
			return format.ok(dryRun ? { dryRun: true, plans } : { dryRun: false, synced: manifests.map((m) => m.slug) });
		}
		log.info(`Synced ${manifests.length} partial${manifests.length === 1 ? '' : 's'}.`);
		if (!dryRun) {
			await refreshAgents(themeDir);
		}
		return true;
	}

	const name = (args._ && args._[2]) || args['--name'] || args['--slug'];
	if (!name) {
		log.error('Pass a partial name or slug, or use --all. Example: wonderpress partial sync Scalar_Demo');
		return format.fail({
			code: 'usage',
			message: 'Pass a partial name or slug, or use --all',
			hint: 'wonderpress partial sync Scalar_Demo',
		}, format.EXIT_USAGE);
	}

	const lookupSlug = nameToSlug(name);
	if (!isSafeSlug(lookupSlug)) {
		log.error(`Invalid partial name "${name}".`);
		return format.fail({ code: 'usage', message: `Invalid partial name "${name}"` }, format.EXIT_USAGE);
	}

	const manifest = readManifest(themeDir, lookupSlug);
	if (!manifest) {
		log.error(`No partial manifest for "${name}". Run \`wonderpress partial list\`.`);
		return format.fail({
			code: 'not_found',
			message: `No partial manifest for "${name}"`,
			hint: 'wonderpress partial list',
		});
	}

	try {
		const result = syncPartialFromManifest(manifest, themeDir, { dryRun, propertiesOnly });
		if (dryRun && result && result.slug) {
			plans.push(result);
		}
	} catch (err) {
		log.error(err.message);
		return format.fail({ code: 'sync', message: err.message });
	}

	if (!dryRun) {
		log.warn(
			'The partial class file was regenerated from the manifest template. Custom code in that class is not preserved — keep custom logic in separate helpers or the view template.',
		);
		await refreshAgents(themeDir);
	}

	if (format.isJson()) {
		return format.ok(dryRun ? { dryRun: true, plans } : { dryRun: false, synced: [manifest.slug] });
	}

	return true;
}

/**
 * Fail when manifest-derived artifacts drift (class $_properties, block.json).
 **/
export async function checkDrift(args) {
	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return format.fail({
			code: 'theme',
			message: 'Could not resolve the theme directory',
			hint: 'Pass --theme <name> and --dir <env-root>.',
		});
	}

	const checkAll = args['--all'] === true;
	const name = (args._ && args._[2]) || args['--name'] || args['--slug'];

	const manifests = checkAll
		? readManifests(themeDir)
		: (() => {
				if (!name) {
					log.error('Pass a partial name or slug, or use --all. Example: wonderpress partial check-drift Scalar_Demo');
					return null;
				}
				const lookupSlug = nameToSlug(name);
				if (!isSafeSlug(lookupSlug)) {
					log.error(`Invalid partial name "${name}".`);
					return null;
				}
				const manifest = readManifest(themeDir, lookupSlug);
				if (!manifest) {
					log.error(`No partial manifest for "${name}".`);
					return null;
				}
				return [manifest];
			})();

	if (!manifests) {
		return format.fail({
			code: 'usage',
			message: name ? `No partial manifest for "${name}"` : 'Pass a partial name or slug, or use --all',
			hint: 'wonderpress partial check-drift --all',
		}, name && isSafeSlug(nameToSlug(name)) ? format.EXIT_FAIL : format.EXIT_USAGE);
	}
	if (!manifests.length) {
		if (format.isJson()) {
			return format.ok({ results: [] });
		}
		log.info(`No partial manifests in ${themeDir}.`);
		return true;
	}

	let failed = false;
	const results = [];
	for (const manifest of manifests) {
		const result = checkPartialDrift(manifest, themeDir);
		results.push(result);
		if (result.ok) {
			log.success(`${manifest.slug}: in sync with manifest.`);
			continue;
		}
		failed = true;
		log.error(`${manifest.slug}: drift detected.`);
		for (const issue of result.issues) {
			log.error(`  • ${issue.message}`);
		}
	}

	if (failed) {
		process.exitCode = format.EXIT_FAIL;
		if (format.isJson()) {
			return format.fail(
				{ code: 'drift', message: 'One or more partials drifted from their manifests', hint: 'wonderpress partial sync --all' },
				format.EXIT_FAIL,
				{ results },
			);
		}
		return false;
	}

	if (format.isJson()) {
		return format.ok({ results });
	}

	log.info(`${manifests.length} partial${manifests.length === 1 ? '' : 's'} checked.`);
	return true;
}

export async function list(args) {

	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return format.fail({
			code: 'theme',
			message: 'Could not resolve the theme directory',
			hint: 'Pass --theme <name> and --dir <env-root>.',
		});
	}

	const rows = listPartials(themeDir);
	if (format.isJson()) {
		return format.ok({ partials: rows });
	}
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

	const file = resolveWithin(themeDir, `${PARTIAL_MANIFEST_DIR}/${slug}.json`);
	if (!file) {
		log.error(`Refusing to remove the manifest for "${slug}": that path escapes the theme directory.`);
		return false;
	}

	fs.removeSync(file);
	log.success(`Removed manifest: ${file}`);
	return true;
}

/**
 * Copy a core-bundled primitive manifest into the theme (Pass 2: Link).
 **/
export async function installManifest(args) {
	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

	const slug = args._ && args._[2] ? nameToSlug(args._[2]) : nameToSlug(args['--slug'] || '');
	if (!slug) {
		log.error('Usage: wonderpress partial install-manifest <slug> (e.g. link)');
		log.info(`Available core primitives: ${CORE_PARTIAL_MANIFEST_SLUGS.join(', ')}`);
		return false;
	}

	if (!CORE_PARTIAL_MANIFEST_SLUGS.includes(slug)) {
		log.error(`Unknown core primitive "${slug}". Available: ${CORE_PARTIAL_MANIFEST_SLUGS.join(', ')}`);
		return false;
	}

	if (!resolveCoreBundledPartialManifest(themeDir, slug)) {
		log.error(`Could not find bundled manifest for "${slug}" in wonderpress-core. Is the package installed?`);
		return false;
	}

	const dest = installCorePartialManifest(themeDir, slug);
	if (!dest) {
		log.error(`Failed to install manifest for "${slug}".`);
		return false;
	}

	log.success(`Installed core manifest: ${dest}`);
	log.info('Add the partial to a template composition or wonderpress_template_fields so ACF registers the field group where editors need it.');
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

	let name = args._ && args._[2] ? args._[2] : args['--name'];

	if (!name) {
		// Every partial, blocks included. `remove` refuses a partial a block
		// wraps unless --with-block is passed, so the label says which ones
		// will ask for that rather than letting it be a surprise.
		name = await pickOne({
			message: 'Which partial should be removed?',
			choices: listPartials(themeDir).map((p) => ({
				name: p.block ? `${p.name}  (${p.slug}) — wrapped by ${p.block}` : `${p.name}  (${p.slug})`,
				value: p.name,
			})),
			empty: 'This theme has no partials to remove.',
			usage: 'Usage: wonderpress partial remove <Name>.',
			args,
		});

		if (!name) {
			return false;
		}
	}

	return removePartial(themeDir, name, { withBlock: !!args['--with-block'] });
}

/**
 * Interactive wizard — a thin convenience wrapper that collects the same
 * params the flags would, then returns them for writePartial().
 **/
/**
 * Which wizard questions the command line has already answered.
 *
 * A question whose answer was given as a flag is not a question. Undefined
 * means "still worth asking"; anything else is the answer.
 **/
export function seedFromFlags(args = {}) {
	return {
		is_acf_compatible: args['--acf'] === true ? true : undefined,
		has_partial_template: args['--no-template'] === true ? false : undefined,
		partial_template_name: args['--template-name'],
		emit_script: args['--js'] === true ? true : undefined,
		emit_block: args['--block'] === true ? true : undefined,
	};
}

/**
 * Fold the wizard's answers together with the flags that pre-empted them.
 *
 * Separate from the prompting so the rules can be tested without a terminal.
 * `??` rather than `||` throughout: `false` is a real answer, and
 * `--no-template` means false rather than unanswered.
 **/
export function mergeWizardAnswers(step1, args = {}, properties = []) {

	const flagged = seedFromFlags(args);
	const hasTemplate = step1.has_partial_template ?? flagged.has_partial_template ?? true;
	const templateName = step1.partial_template_name ?? flagged.partial_template_name;

	return {
		class_name: step1.class_name,
		is_acf_compatible: step1.is_acf_compatible ?? flagged.is_acf_compatible ?? false,
		has_partial_template: hasTemplate,
		partial_template_name: hasTemplate
			? (templateName || defaultTemplateName(step1.class_name))
			: defaultTemplateName(step1.class_name),
		properties: properties.length
			? properties
			: attachSubFields((args['--prop'] || []).map(parsePropFlag), args['--sub'] || []),
		emit: {
			block: step1.emit_block ?? flagged.emit_block ?? false,
			manifest: !args['--no-manifest'],
			style: !args['--no-style'],
			script: step1.emit_script ?? flagged.emit_script ?? false,
		},
	};
}

async function runWizard(themeDir, args = {}) {

	const flagged = seedFromFlags(args);
	const asked = (key) => flagged[key] === undefined;

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
			message: 'Should this partial register an ACF field group?',
			suffix: '\nCore reads the manifest and registers the group when ACF is present. Say "N" unless a PHP template will hydrate this partial via ACF:',
			default: false,
			when: () => asked('is_acf_compatible'),
		},
		{
			type: 'confirm',
			name: 'has_partial_template',
			message: 'Should we create a view template for this partial?',
			suffix: `\nThis file will be created in ${themeDir}/partials`,
			default: true,
			when: () => asked('has_partial_template'),
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
				return asked('emit_script') && answers.has_partial_template !== false;
			}
		},
		{
			type: 'confirm',
			name: 'emit_block',
			message: 'Also expose this partial as a Gutenberg block?',
			suffix: '\nMost partials are compositional and should not be blocks; say "N" unless you want it in the editor:',
			default: false,
			when: () => asked('emit_block'),
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
			const property = {
				name: answers.name,
				type: answers.type,
				required: answers.required,
				description: answers.description || '',
			};
			if (answers.type === 'repeater') {
				property.properties = await promptRepeaterSubs(answers.name);
			}
			properties.push(property);
		}
	}

	return mergeWizardAnswers(step1, args, properties);
}

/**
 * Collect the rows of a repeater. Same questions as a top-level property,
 * but the type list is the subset a repeater row may honestly hold.
 **/
async function promptRepeaterSubs(parentName) {
	const subs = [];
	let addAnother = true;

	log.instructions(`Repeater "${parentName}" needs at least one sub-field — the shape of each row.`);

	while (addAnother) {
		const addMessage = subs.length
			? `Add another sub-field to "${parentName}"?`
			: `Add a sub-field to "${parentName}"?`;

		const answers = await inquirer.prompt([
			{
				type: 'confirm',
				name: 'add_another',
				message: addMessage,
				default: subs.length === 0,
			},
			{
				type: 'input',
				name: 'name',
				message: 'Sub-field name?',
				when: (a) => a.add_another,
			},
			{
				type: 'list',
				name: 'type',
				message: 'Sub-field type?',
				choices: REPEATER_SUB_TYPES,
				default: 'string',
				when: (a) => a.add_another,
			},
			{
				type: 'input',
				name: 'description',
				message: 'Briefly describe the sub-field',
				when: (a) => a.add_another,
			},
			{
				type: 'confirm',
				name: 'required',
				message: 'Required?',
				when: (a) => a.add_another,
			},
		]);

		if (!answers.add_another) {
			addAnother = false;
		} else {
			subs.push({
				name: answers.name,
				type: answers.type,
				required: answers.required,
				description: answers.description || '',
			});
		}
	}

	return subs;
}
