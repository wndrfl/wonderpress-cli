import fs from 'fs-extra';
import path from 'path';
import * as config from './config.js';
import * as core from './core.js';
import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import * as wordpress from './wordpress.js';
import { toPosixPath } from './proc.js';
import {
	manifestPath,
	namespaceFromBlocks,
	readManifest,
	validateParams,
	writeManifest,
} from './partial.js';
import { writePartialLock, partialLockRelPath } from './partial-lock.js';
import { checkPartialDrift } from './partial-drift.js';
import { importStaticKit, isStaticKitTree, staticKitDir } from './static-kit.js';
import {
	inventoryLegacyPartials,
	LEGACY_BACKUP_SUFFIX,
	LEGACY_CLASS_DIR,
	parseLegacyClass,
	parseTypeOverrides,
	planMigration,
	renderMigratedClass,
} from './legacy-partial.js';
import {
	isValidNamespace,
	MANIFEST_ROOT,
	nameToSlug,
	PAGE_TEMPLATE_MANIFEST_DIR,
	PARTIAL_MANIFEST_DIR,
	resolveWithin,
} from './validate.js';

/**
 * `wonderpress theme adopt [--theme <name>] [--namespace <ns>]`.
 *
 * Brings a theme built before manifests existed under the CLI's contract. The
 * desktop app recognises a theme only by its `.wonderpress/manifest/` tree,
 * and until now nothing created that tree on purpose: `partial create` made it
 * as a side effect, and a site whose theme predates manifests had no way in
 * short of creating a partial it did not want.
 *
 * Adopt does the minimum: the two manifest directories, and (only when asked)
 * the block namespace in .wonderpressrc. It migrates nothing. Existing partials
 * are counted so the caller can say "3 partials are not under manifests yet",
 * and otherwise left exactly as they are.
 **/

export async function command(subcommand, args) {
	switch (subcommand) {
		case 'adopt':
			await adopt(args);
			break;
		case 'migrate':
			await migrate(args);
			break;
		default:
			// Same convention as `partial`: no subcommand shows the group, an
			// unknown one says so first.
			if (subcommand) {
				log.error(`Unknown theme subcommand: ${subcommand}`);
				format.fail({
					code: 'unknown_command',
					message: `Unknown theme subcommand: ${subcommand}`,
					hint: 'Run `wonderpress theme help`.',
				});
			}
			help.show('theme');
			break;
	}

	return true;
}

/**
 * Which theme adopt operates on, from the disk alone.
 *
 * Deliberately not `getActiveTheme()`: a project being adopted may have no
 * reachable database, and a theme that exists on disk is adoptable whether or
 * not WordPress currently runs it. One theme needs no flag; several need
 * --theme, and the error names them so the next invocation can be typed from it.
 *
 * -> { name } | { error }
 **/
export function pickTheme(args, themes) {

	const requested = args['--theme'];

	if (requested) {
		if (!themes.includes(requested)) {
			return {
				error: {
					code: 'theme_not_found',
					message: `No theme named "${requested}" in ${wordpress.pathToThemesDir}`,
					hint: themes.length ? `Themes on disk: ${themes.join(', ')}.` : 'No theme with a style.css was found.',
				},
			};
		}
		return { name: requested };
	}

	if (themes.length === 1) {
		return { name: themes[0] };
	}

	if (themes.length === 0) {
		return {
			error: {
				code: 'no_theme',
				message: `No theme found in ${wordpress.pathToThemesDir}`,
				hint: 'A theme is a directory with a style.css. Nothing here has one.',
			},
		};
	}

	return {
		error: {
			code: 'ambiguous_theme',
			message: `Several themes in ${wordpress.pathToThemesDir}; pass --theme <name>`,
			hint: `Themes on disk: ${themes.join(', ')}.`,
		},
	};
}

/**
 * Directories directly under `<theme>/partials`.
 *
 * A pre-manifest theme kept each partial in its own folder there. They are
 * counted, never read or moved: adopt reports how much is still outside the
 * manifests, and leaves the migration to a later, deliberate step.
 **/
export function countLegacyPartials(themeDir) {

	const dir = path.join(themeDir, 'partials');
	if (!fs.existsSync(dir)) {
		return 0;
	}

	return fs.readdirSync(dir).filter((entry) => {
		const stat = fs.statSync(path.join(dir, entry), { throwIfNoEntry: false });
		return stat !== undefined && stat.isDirectory();
	}).length;
}

/**
 * Do the adoption against a resolved theme directory, with the cwd already at
 * the environment root. Returns the data half of the envelope, or throws
 * nothing: every failure before this point has been reported by the caller.
 *
 * `created` is true when at least one of the two directories did not exist.
 * Running adopt twice is the normal case (the app re-checks), so the second
 * run reports `created: false` and changes nothing.
 **/
export function adoptTheme({ root, themeName, themeDir, namespace }) {

	const dirs = [PARTIAL_MANIFEST_DIR, PAGE_TEMPLATE_MANIFEST_DIR].map((rel) => path.join(themeDir, rel));
	const created = dirs.some((dir) => !fs.existsSync(dir));
	for (const dir of dirs) {
		fs.ensureDirSync(dir);
	}

	let namespaceSource = 'none';
	let resolved = null;

	if (namespace) {
		resolved = namespace;
		namespaceSource = 'rc';
	} else {
		const recorded = config.read(root).data.namespace;
		if (isValidNamespace(recorded)) {
			resolved = recorded;
			namespaceSource = 'rc';
		} else {
			const fromBlocks = namespaceFromBlocks(themeDir);
			if (fromBlocks) {
				resolved = fromBlocks;
				namespaceSource = 'blocks';
			}
		}
	}

	return {
		theme: themeName,
		manifestDir: path.resolve(themeDir, MANIFEST_ROOT),
		created,
		namespace: resolved,
		namespaceSource,
		legacyPartials: countLegacyPartials(themeDir),
	};
}

export async function adopt(args) {

	process.chdir(args['--dir'] ? args['--dir'] : '.');

	if (! await core.setCwdToEnvironmentRoot()) {
		return format.fail({
			code: 'env',
			message: 'This does not appear to be a Wonderpress Development Environment',
			hint: 'Run from inside a project, or pass --dir <root>.',
		});
	}

	const root = process.cwd();

	// Validate the flag before touching anything: a refused namespace must not
	// leave half an adoption behind.
	const namespace = args['--namespace'];
	if (namespace !== undefined && !isValidNamespace(namespace)) {
		log.error(`Invalid namespace "${namespace}": lowercase letters, digits and dashes, starting with a letter.`);
		return format.fail({
			code: 'usage',
			message: `Invalid namespace "${namespace}"`,
			hint: 'Use lowercase letters, digits and dashes, starting with a letter (e.g. acme).',
		}, format.EXIT_USAGE);
	}

	const picked = pickTheme(args, wordpress.themesOnDisk());
	if (picked.error) {
		log.error(`${picked.error.message}. ${picked.error.hint}`);
		return format.fail(picked.error);
	}

	const themeName = picked.name;
	const themeDir = path.join(wordpress.pathToThemesDir, themeName);

	// Record the namespace first: if the rc file cannot be written there is no
	// point creating directories the app will then find without one.
	if (namespace !== undefined) {
		const existing = config.read(root).data.namespace;
		if (isValidNamespace(existing) && existing !== namespace) {
			log.warn(`This project's blocks are namespaced \`${existing}\`, and --namespace asks for \`${namespace}\`.`);
			log.warn(`Blocks already placed on pages stay \`${existing}\` and will stop resolving. Only do this before a site has content.`);
		}
		if (!config.write(root, { namespace })) {
			return format.fail({
				code: 'rc_unwritable',
				message: 'Could not record the namespace in .wonderpressrc',
				hint: 'The file is not JSON. Fix it by hand, then run adopt again.',
			});
		}
	}

	const data = adoptTheme({ root, themeName, themeDir, namespace });

	if (format.isJson()) {
		return format.ok(data);
	}

	// Forward slashes on every OS, matching the paths the CLI prints from manifests.
	const manifestRel = toPosixPath(path.join(themeDir, MANIFEST_ROOT));
	if (data.created) {
		log.success(`Created ${manifestRel}`);
	} else {
		log.info(`${manifestRel} already exists; nothing to create.`);
	}

	if (namespace !== undefined) {
		log.success(`Recorded namespace \`${namespace}\` in .wonderpressrc`);
	} else if (data.namespaceSource === 'rc') {
		log.info(`Namespace \`${data.namespace}\` (from .wonderpressrc)`);
	} else if (data.namespaceSource === 'blocks') {
		log.info(`Namespace \`${data.namespace}\` (from this theme's existing blocks; not yet recorded in .wonderpressrc)`);
	} else {
		log.warn('No namespace recorded. Blocks will be namespaced after the theme until one is (--namespace <ns> to record one).');
	}

	if (data.legacyPartials) {
		log.info(`${data.legacyPartials} partial director${data.legacyPartials === 1 ? 'y' : 'ies'} under partials/ left as ${data.legacyPartials === 1 ? 'it is' : 'they are'}; nothing was migrated.`);
	}

	return true;
}

// --- theme migrate ----------------------------------------------------------

/**
 * `wonderpress theme migrate --list | <slug> [--type name=type ...] [--apply]`.
 *
 * The step after adopt: bring one class-based legacy partial under a manifest.
 * `--list` is the inventory (what is there, what is ready, what needs a
 * decision). Without `--apply` the command is a dry run that prints the
 * manifest it would write and the review notes, and touches nothing. With
 * `--apply` it writes the manifest, regenerates the class with the fence
 * `partial sync` maintains (custom members preserved below it, the original
 * kept as `class-<slug>.php.legacy`), leaves the view alone, asks Static Kit
 * for the style stub only if the theme has a static tree, and records the sync
 * lock so check-drift reads clean. See ARCHITECTURE.md "Migrating class-based
 * legacy partials".
 *
 * ACF blocks (`partials/blocks/*.php`) are out of scope: listed, never touched.
 **/
export async function migrate(args) {

	process.chdir(args['--dir'] ? args['--dir'] : '.');

	if (! await core.setCwdToEnvironmentRoot()) {
		return format.fail({
			code: 'env',
			message: 'This does not appear to be a Wonderpress Development Environment',
			hint: 'Run from inside a project, or pass --dir <root>.',
		});
	}

	const picked = pickTheme(args, wordpress.themesOnDisk());
	if (picked.error) {
		log.error(`${picked.error.message}. ${picked.error.hint}`);
		return format.fail(picked.error);
	}
	const themeName = picked.name;
	const themeDir = path.join(wordpress.pathToThemesDir, themeName);

	// Migrate writes into the manifest tree, so the tree has to exist first.
	// Adopt is the deliberate step that creates it; migrate does not do it as
	// a side effect.
	if (!fs.existsSync(path.join(themeDir, PARTIAL_MANIFEST_DIR))) {
		log.error(`${themeName} has no ${MANIFEST_ROOT} tree yet. Run: wonderpress theme adopt${args['--theme'] ? ` --theme ${themeName}` : ''}`);
		return format.fail({
			code: 'not_adopted',
			message: `Theme "${themeName}" has no ${MANIFEST_ROOT} tree`,
			hint: `wonderpress theme adopt${args['--theme'] ? ` --theme ${themeName}` : ''}`,
		});
	}

	if (args['--list'] === true) {
		return migrateList(themeName, themeDir);
	}

	const requested = args._ && args._[2];
	if (!requested) {
		log.error('Pass a partial slug, or --list to see the inventory. Example: wonderpress theme migrate theme-text-stack');
		return format.fail({
			code: 'usage',
			message: 'Pass a partial slug, or --list',
			hint: 'wonderpress theme migrate --list',
		}, format.EXIT_USAGE);
	}

	return migrateOne(themeName, themeDir, requested, args);
}

function migrateList(themeName, themeDir) {
	const partials = inventoryLegacyPartials(themeDir);

	if (format.isJson()) {
		return format.ok({ theme: themeName, partials });
	}

	const classes = partials.filter((p) => p.kind === 'class');
	const blocks = partials.filter((p) => p.kind === 'acf-block');
	if (!classes.length && !blocks.length) {
		log.info(`No legacy partial classes under ${LEGACY_CLASS_DIR}/ in ${themeName}.`);
		return true;
	}
	if (classes.length) {
		log.info(`${classes.length} partial class${classes.length === 1 ? '' : 'es'} under ${LEGACY_CLASS_DIR}/:`);
		for (const p of classes) {
			const view = p.viewPath ? p.viewPath : 'no view';
			const count = `${p.properties} propert${p.properties === 1 ? 'y' : 'ies'}`;
			const line = `${p.slug}  ${p.status}  (${p.className || '?'}, ${view}, ${count})`;
			if (p.status === 'migrated') {
				log.success(line);
			} else if (p.status === 'review') {
				log.warn(`${line}${p.error ? ` — ${p.error}` : ''}`);
			} else {
				log.info(line);
			}
		}
	}
	if (blocks.length) {
		log.info(`${blocks.length} ACF block${blocks.length === 1 ? '' : 's'} under partials/blocks/ (not migrated; out of scope):`);
		for (const b of blocks) {
			log.info(`${b.slug}  ${b.status}`);
		}
	}
	const ready = classes.filter((p) => p.status === 'ready').length;
	const review = classes.filter((p) => p.status === 'review').length;
	log.info(`${ready} ready, ${review} need review. Dry run one with: wonderpress theme migrate <slug>`);
	return true;
}

/**
 * Locate the legacy class a slug (or class name) refers to.
 *
 * @returns {{ entry: object } | { error: object }}
 */
function findLegacy(themeDir, requested) {
	const slug = nameToSlug(requested);
	const inventory = inventoryLegacyPartials(themeDir).filter((p) => p.kind === 'class');
	const entry = inventory.find((p) => p.slug === slug)
		|| inventory.find((p) => p.classPath === `${LEGACY_CLASS_DIR}/class-${slug}.php`);
	if (!entry) {
		return {
			error: {
				code: 'not_found',
				message: `No legacy partial class for "${requested}" under ${LEGACY_CLASS_DIR}/`,
				hint: inventory.length ? `Known: ${inventory.map((p) => p.slug).join(', ')}. See: wonderpress theme migrate --list` : 'wonderpress theme migrate --list',
			},
		};
	}
	return { entry };
}

async function migrateOne(themeName, themeDir, requested, args) {
	const apply = args['--apply'] === true;

	const found = findLegacy(themeDir, requested);
	if (found.error) {
		log.error(`${found.error.message}. ${found.error.hint}`);
		return format.fail(found.error);
	}
	const entry = found.entry;
	const classAbs = path.join(themeDir, entry.classPath);

	// Already under a manifest: nothing to do, and say so. This is also what
	// makes a second --apply a no-op. Decided before the class is parsed again,
	// because the regenerated class is no longer the legacy one.
	if (entry.status === 'migrated') {
		const manifest = readManifest(themeDir, entry.slug);
		const manifestRel = `${PARTIAL_MANIFEST_DIR}/${entry.slug}.json`;
		const data = {
			slug: entry.slug,
			manifestPath: path.resolve(manifestPath(themeDir, entry.slug)),
			properties: (manifest?.properties || []).map((p) => ({ name: p.name, type: p.type, source: 'manifest', review: false, note: null })),
			notes: [`${manifestRel} already exists; ${entry.slug} is migrated. Nothing written.`],
			review: false,
			applied: false,
			files: { written: [], preserved: [] },
			manifest,
		};
		if (format.isJson()) {
			return format.ok(data);
		}
		log.info(`${entry.slug} is already migrated (${manifestRel} exists). Nothing to do.`);
		return true;
	}

	let legacy;
	try {
		legacy = parseLegacyClass(fs.readFileSync(classAbs, 'utf8'));
	} catch (err) {
		log.error(`Could not read ${entry.classPath}: ${err.message}`);
		return format.fail({
			code: 'parse',
			message: `Could not read ${entry.classPath}: ${err.message}`,
			hint: 'The legacy $_properties array must be a plain PHP array literal.',
		});
	}

	let overrides;
	try {
		overrides = parseTypeOverrides(args['--type'], legacy.properties.map((p) => p.name));
	} catch (err) {
		log.error(err.message);
		return format.fail({ code: 'usage', message: err.message, hint: 'wonderpress theme migrate <slug> --type <name>=<type>' }, format.EXIT_USAGE);
	}

	const plan = planMigration(legacy, { overrides });
	const slug = plan.slug;
	const manifestFile = manifestPath(themeDir, slug);
	const manifestRel = `${PARTIAL_MANIFEST_DIR}/${slug}.json`;

	// The manifest the write would produce, validated the way sync validates
	// it, so an override that needs more than a type (select without
	// choices) fails here rather than half way through an apply.
	try {
		validateParams(plan.params, themeDir);
	} catch (err) {
		log.error(err.message);
		return format.fail({ code: 'invalid', message: err.message, hint: 'Choose another --type, or fix the legacy class first.' });
	}

	const manifestPreview = {
		name: plan.params.class_name,
		slug,
		acf_compatible: false,
		properties: plan.params.properties,
		artifacts: {
			class: entry.classPath,
			...(plan.params.has_partial_template ? { view: `partials/${plan.params.partial_template_name}` } : {}),
		},
	};

	const data = {
		slug,
		manifestPath: path.resolve(manifestFile),
		properties: plan.properties,
		notes: plan.notes.concat(plan.blockers),
		review: plan.review,
		applied: false,
		files: { written: [], preserved: [] },
		manifest: manifestPreview,
	};

	if (!apply) {
		if (format.isJson()) {
			return format.ok(data);
		}
		printPlan(slug, entry, plan, manifestPreview);
		if (plan.review) {
			log.warn(`Needs review before --apply: ${reviewHint(plan)}`);
		} else {
			log.info(`Dry run; nothing written. Apply with: wonderpress theme migrate ${slug} --apply`);
		}
		return true;
	}

	if (plan.review) {
		const message = `Refusing to apply ${slug}: ${plan.properties.filter((p) => p.review).length} propert${plan.properties.filter((p) => p.review).length === 1 ? 'y needs' : 'ies need'} a decision${plan.blockers.length ? ` and ${plan.blockers.length} other item${plan.blockers.length === 1 ? '' : 's'} need${plan.blockers.length === 1 ? 's' : ''} attention` : ''}`;
		log.error(`${message}. ${reviewHint(plan)}`);
		for (const note of plan.blockers) {
			log.warn(note);
		}
		return format.fail({ code: 'review', message, hint: reviewHint(plan) }, format.EXIT_FAIL, data);
	}

	// --- apply ---
	const written = [];
	const preserved = [];

	// The original beside the regenerated class, never overwritten: a
	// second apply after a manual rollback must not clobber the first copy.
	const backupRel = `${entry.classPath}${LEGACY_BACKUP_SUFFIX}`;
	const backupAbs = resolveWithin(themeDir, backupRel);
	if (!fs.existsSync(backupAbs)) {
		fs.copyFileSync(classAbs, backupAbs);
	}
	preserved.push(backupRel);

	fs.writeFileSync(classAbs, renderMigratedClass(plan.params, legacy));
	written.push(entry.classPath);
	log.success(`Regenerated ${entry.classPath} with <wonderpress:generated> markers; custom members kept below them.`);
	log.info(`Original saved as ${backupRel}; delete it once you have compared the two.`);

	if (plan.viewPath) {
		preserved.push(plan.viewPath);
	}

	// The style stub goes through Static Kit, as partial create does, and only
	// when the theme has a static tree. Static Kit never overwrites an existing
	// stub, so a theme that already styles this partial keeps its file.
	let style = false;
	if (plan.params.has_partial_template && isStaticKitTree(staticKitDir(themeDir))) {
		const staticCli = await importStaticKit();
		if (staticCli.component && typeof staticCli.component.create === 'function') {
			const styleBefore = new Set(existingStyleFiles(themeDir));
			const created = await staticCli.component.create(staticKitDir(themeDir), slug, { style: true, script: false });
			const item = created?.ok && Array.isArray(created.data?.wrote) ? created.data.wrote.find((w) => w.kind === 'style') : null;
			if (item) {
				style = toPosixPath(path.relative(themeDir, item.path));
				(styleBefore.has(item.path) ? preserved : written).push(style);
			}
		}
	}

	writeManifest(plan.params, themeDir, { class: entry.classPath, style });
	written.push(manifestRel);

	// The lock last, over exactly what was written, so check-drift is clean.
	writePartialLock(readManifest(themeDir, slug), themeDir);
	written.push(partialLockRelPath(slug));

	await refreshAgentsQuietly(themeDir);

	data.applied = true;
	data.manifest = readManifest(themeDir, slug);
	data.files = { written, preserved };
	data.drift = checkPartialDrift(data.manifest, themeDir).state;

	if (format.isJson()) {
		return format.ok(data);
	}
	log.success(`Migrated ${slug}: ${manifestRel}`);
	for (const note of plan.notes) {
		log.info(note);
	}
	for (const p of plan.properties.filter((prop) => prop.note)) {
		log.info(`${p.name}: ${p.note}`);
	}
	log.info(`check-drift: ${data.drift}. Next: wonderpress partial sync ${plan.params.class_name} after any manifest edit.`);
	return true;
}

function existingStyleFiles(themeDir) {
	const dir = path.join(staticKitDir(themeDir), 'src/scss/components');
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir).map((f) => path.join(dir, f));
}

function reviewHint(plan) {
	const flags = plan.properties.filter((p) => p.review).map((p) => `--type ${p.name}=<type>`);
	const parts = [];
	if (flags.length) {
		parts.push(`re-run with ${flags.join(' ')}`);
	}
	if (plan.blockers.length) {
		parts.push(plan.blockers.join(' '));
	}
	return parts.join('. ');
}

function printPlan(slug, entry, plan, manifestPreview) {
	log.info(`Dry run for ${slug} (${entry.classPath}${plan.viewPath ? `, view ${plan.viewPath}` : ', no view'}).`);
	log.info('Manifest that would be written:');
	for (const line of JSON.stringify(manifestPreview, null, 2).split('\n')) {
		process.stdout.write(`    ${line}\n`);
	}
	for (const p of plan.properties) {
		const text = `${p.name}: ${p.type} (${p.source})${p.note ? ` — ${p.note}` : ''}`;
		if (p.review) {
			log.warn(text);
		} else {
			log.info(text);
		}
	}
	for (const note of plan.notes) {
		log.info(note);
	}
	for (const note of plan.blockers) {
		log.warn(note);
	}
}

async function refreshAgentsQuietly(themeDir) {
	try {
		const agents = await import('./agents.js');
		agents.writeAgentFiles({ root: process.cwd(), themeDir });
	} catch (err) {
		log.warn(`Could not refresh AGENTS.md: ${err.message}`);
	}
}
