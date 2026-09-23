import fs from 'fs-extra';
import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import * as partial from './partial.js';
import { isSafeSlug, nameToSlug, resolveWithin } from './validate.js';
import { pickOne } from './prompt.js';

/**
 * Blocks.
 *
 * A block is definitionally a thin wrapper over a partial: its render.php
 * delegates to the partial class, so a block cannot exist without one (while a
 * partial lives perfectly well without a block). Everything here therefore
 * works through the partial's manifest — the CLI's index of what a theme
 * contains — and never scaffolds a partial of its own.
 **/

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
		default:
			if (subcommand) {
				log.error(`Unknown block subcommand: ${subcommand}`);
				process.exitCode = format.EXIT_FAIL;
				format.fail({
					code: 'unknown_command',
					message: `Unknown block subcommand: ${subcommand}`,
					hint: 'Run `wonderpress block help`.',
				});
			}
			help.show('block');
			break;
	}

	return true;
}

/**
 * Wrap an existing partial in a block, and record it in the manifest.
 *
 * `name` may be a class name (`Call_To_Action`) or a slug (`call-to-action`).
 * The block is rewritten from the manifest's contract — the same params the
 * partial was created with — so the result is identical to having passed
 * `--block` at creation time.
 **/
export function addBlock(themeDir, name) {

	const lookupSlug = nameToSlug(name);
	if (!isSafeSlug(lookupSlug)) {
		log.error(`Invalid partial name "${name}". A component name resolves to a slug of lowercase letters, numbers, and dashes.`);
		return false;
	}

	const manifest = partial.readManifest(themeDir, lookupSlug);
	if (!manifest) {
		log.error(`No partial named "${name}" is recorded in this theme. A block is a wrapper around a partial, so create both at once with \`wonderpress partial create --name ${name} --block\`.`);
		return false;
	}

	if (manifest.block) {
		log.info(`"${manifest.name}" is already exposed as ${manifest.block}. Rewriting it from the manifest...`);
	}

	// The manifest is a file on disk, so its contract is re-validated before we
	// write anything derived from it.
	const artifacts = manifest.artifacts || {};
	let params;
	try {
		params = partial.paramsFromManifest(manifest);
		params.emit.block = true;
		partial.validateParams(params, themeDir);
	} catch (err) {
		log.error(`Cannot wrap "${name}" in a block: ${err.message}`);
		return false;
	}

	// Resolved from the project, not the manifest being rewrapped — so a block
	// added later lands in the same namespace as the ones already placed.
	params.namespace = partial.resolveNamespace(themeDir);

	partial.writeBlock(params, themeDir);
	partial.writeManifest(params, themeDir, {
		style: !!artifacts.style,
		script: !!artifacts.script,
	});

	return true;
}

/**
 * Create a block around an existing partial (`block create <Name>`).
 **/
export async function create(args) {

	const themeDir = await partial.resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

	let name = args._ && args._[2] ? args._[2] : args['--name'];

	if (!name) {
		const partials = partial.listPartials(themeDir);

		// Only the ones without a block. Re-wrapping an existing one is
		// idempotent rather than harmful, but offering it implies something is
		// missing when nothing is — and naming it explicitly still works.
		name = await pickOne({
			message: 'Which partial should be exposed as a block?',
			choices: partials
				.filter((p) => !p.block)
				.map((p) => ({ name: `${p.name}  (${p.slug})`, value: p.name })),
			empty: partials.length
				? `Every partial in this theme is already exposed as a block (${partials.length}). Nothing to add.`
				: 'This theme has no partials yet. Create one first: wonderpress partial create <Name>',
				usage: 'Usage: wonderpress block create <Name>.',
			args,
		});

		if (!name) {
			return format.fail({
				code: 'usage',
				message: 'block create requires a partial name or an interactive TTY',
				hint: 'wonderpress block create Hero',
			}, format.EXIT_USAGE);
		}
	}

	const ok = addBlock(themeDir, name);
	if (!ok) {
		return format.fail({
			code: 'block',
			message: `Could not wrap "${name}" in a block`,
		});
	}

	try {
		const agents = await import('./agents.js');
		agents.writeAgentFiles({ root: process.cwd(), themeDir });
	} catch (err) {
		log.warn(`Could not refresh AGENTS.md: ${err.message}`);
	}

	if (format.isJson()) {
		const slug = nameToSlug(name);
		const manifest = partial.readManifest(themeDir, slug);
		return format.ok({
			name: manifest?.name || name,
			slug: manifest?.slug || slug,
			block: manifest?.block || null,
		});
	}

	return true;
}

/**
 * Rows for `block list`: every manifest that advertises a block.
 **/
export function listBlocks(themeDir) {

	const rows = partial.readManifests(themeDir)
		.filter((manifest) => !!manifest.block)
		.map((manifest) => ({
			block: manifest.block,
			partial: manifest.name,
			slug: manifest.slug,
			managed: true,
		}));

	// WordPress registers every `blocks/<slug>/block.json` it finds, whether or
	// not the CLI wrote it — so a hand-made block is a real, working block that
	// the manifest knows nothing about. Reporting only what we wrote would make
	// `block list` answer a question it was not asked ("what did the CLI make?")
	// while appearing to answer "what is in this theme?". List those too, marked,
	// rather than quietly under-reporting.
	const known = new Set(rows.map((row) => row.slug));

	for (const found of scanBlockDirs(themeDir)) {
		if (!known.has(found.slug)) {
			rows.push({ ...found, managed: false });
		}
	}

	return rows.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Every block directory physically present in the theme, read the way
 * WordPress reads them: a subdirectory of `blocks/` holding a `block.json`.
 *
 * This deliberately does not consult the manifest — its whole purpose is to
 * see what the manifest cannot.
 **/
export function scanBlockDirs(themeDir) {

	const dir = `${themeDir}/blocks`;
	if (!fs.existsSync(dir)) {
		return [];
	}

	const found = [];

	for (const slug of fs.readdirSync(dir).sort()) {
		const metadata = `${dir}/${slug}/block.json`;
		if (!fs.existsSync(metadata)) {
			continue;
		}

		let name;
		try {
			name = JSON.parse(fs.readFileSync(metadata, 'utf8')).name;
		} catch (e) {
			log.warn(`Skipping unreadable block metadata ${slug}/block.json: ${e.message}`);
			continue;
		}

		found.push({ block: name || `(no name in block.json)`, partial: null, slug });
	}

	return found;
}

/**
 * List every block in the theme.
 **/
export async function list(args) {

	const themeDir = await partial.resolveThemeDir(args);
	if (!themeDir) {
		return format.fail({
			code: 'theme',
			message: 'Could not resolve the theme directory',
			hint: 'Pass --theme <name> and --dir <env-root>.',
		});
	}

	const rows = listBlocks(themeDir);
	if (format.isJson()) {
		return format.ok({ blocks: rows });
	}
	if (!rows.length) {
		log.info(`No blocks found in ${themeDir}. Wrap a partial with \`wonderpress block create <Name>\`.`);
		return true;
	}

	log.table(
		['BLOCK', 'PARTIAL', 'SLUG'],
		rows.map((row) => [row.block, row.managed ? row.partial : '(no manifest)', row.slug])
	);
	log.info(`${rows.length} block${rows.length === 1 ? '' : 's'}.`);

	// An unmanaged block works — WordPress registers it — but the CLI cannot
	// remove it or tell you what it takes, so say so rather than letting the
	// blank column be read as a formatting quirk.
	const unmanaged = rows.filter((row) => !row.managed);
	if (unmanaged.length) {
		log.warn(
			`${unmanaged.length} block${unmanaged.length === 1 ? ' was' : 's were'} not created by the CLI ` +
			`(${unmanaged.map((row) => row.slug).join(', ')}). WordPress registers ${unmanaged.length === 1 ? 'it' : 'them'} ` +
			`normally, but ${unmanaged.length === 1 ? 'it has' : 'they have'} no manifest, so \`block remove\` cannot manage ` +
			`${unmanaged.length === 1 ? 'it' : 'them'} and nothing records what ${unmanaged.length === 1 ? 'it takes' : 'they take'}.`
		);
	}

	return true;
}

/**
 * Unwrap a partial: delete the block directory and strip the block fields from
 * the manifest. The partial itself is left completely untouched.
 **/
export function removeBlock(themeDir, name) {

	const lookupSlug = nameToSlug(name);
	if (!isSafeSlug(lookupSlug)) {
		log.error(`Invalid partial name "${name}". A component name resolves to a slug of lowercase letters, numbers, and dashes.`);
		return false;
	}

	const manifest = partial.readManifest(themeDir, lookupSlug);
	if (!manifest) {
		log.error(`No partial named "${name}" is recorded in this theme. Run \`wonderpress block list\` to see what exists.`);
		return false;
	}

	// The manifest names itself; every derived path comes from that, not from
	// what the user typed.
	const slug = manifest.slug;
	if (!isSafeSlug(slug)) {
		log.error(`The manifest for "${name}" records an unusable slug "${slug}". Fix the manifest before removing this block.`);
		return false;
	}

	if (!manifest.block) {
		log.error(`The partial "${manifest.name}" is not exposed as a block, so there is nothing to remove.`);
		return false;
	}

	partial.removeBlockDir(themeDir, slug);

	// Strip the block from the index. Deleting the keys (rather than rebuilding
	// the object) preserves the ordering of everything else, so the manifest
	// matches one written for a partial that never had a block.
	delete manifest.block;
	if (manifest.artifacts) {
		delete manifest.artifacts.block;
		delete manifest.artifacts.render;
	}

	const file = resolveWithin(themeDir, `.wonderpress/manifest/partials/${slug}.json`);
	if (!file) {
		log.error(`Refusing to rewrite the manifest for "${slug}": that path escapes the theme directory.`);
		return false;
	}

	fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
	log.success(`Manifest updated at: ${file}`);

	return true;
}

/**
 * Remove a block (`block remove <Name>`).
 **/
export async function remove(args) {

	const themeDir = await partial.resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

	let name = args._ && args._[2] ? args._[2] : args['--name'];

	if (!name) {
		name = await pickOne({
			message: 'Which block should be removed? The partial survives.',
			choices: listBlocks(themeDir)
				.filter((row) => row.managed)
				.map((row) => ({ name: `${row.block}  (${row.partial})`, value: row.partial })),
			empty: 'No partial in this theme is exposed as a block, so there is nothing to remove.',
			usage: 'Usage: wonderpress block remove <Name>.',
			args,
		});

		if (!name) {
			return false;
		}
	}

	return removeBlock(themeDir, name);
}
