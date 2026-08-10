import fs from 'fs-extra';
import * as log from './log.js';
import * as partial from './partial.js';
import { nameToSlug } from './validate.js';

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

	const slug = nameToSlug(name);
	const manifest = partial.readManifest(themeDir, slug);
	if (!manifest) {
		log.error(`No partial named "${name}" is recorded in this theme. A block is a wrapper around a partial, so create both at once with \`wonderpress partial create --name ${name} --block\`.`);
		return false;
	}

	if (manifest.block) {
		log.info(`"${manifest.name}" is already exposed as ${manifest.block}. Rewriting it from the manifest...`);
	}

	const artifacts = manifest.artifacts || {};
	const params = partial.paramsFromManifest(manifest);
	params.emit.block = true;

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

	const name = args._ && args._[2] ? args._[2] : args['--name'];
	if (!name) {
		log.error('No name provided. Usage: wonderpress block create <Name>.');
		return false;
	}

	return addBlock(themeDir, name);
}

/**
 * Rows for `block list`: every manifest that advertises a block.
 **/
export function listBlocks(themeDir) {
	return partial.readManifests(themeDir)
		.filter((manifest) => !!manifest.block)
		.map((manifest) => ({
			block: manifest.block,
			partial: manifest.name,
			slug: manifest.slug,
		}));
}

/**
 * List every block in the theme.
 **/
export async function list(args) {

	const themeDir = await partial.resolveThemeDir(args);
	if (!themeDir) {
		return false;
	}

	const rows = listBlocks(themeDir);
	if (!rows.length) {
		log.info(`No blocks found in ${themeDir}. Wrap a partial with \`wonderpress block create <Name>\`.`);
		return true;
	}

	log.table(['BLOCK', 'PARTIAL', 'SLUG'], rows.map((row) => [row.block, row.partial, row.slug]));
	log.info(`${rows.length} block${rows.length === 1 ? '' : 's'}.`);
	return true;
}

/**
 * Unwrap a partial: delete the block directory and strip the block fields from
 * the manifest. The partial itself is left completely untouched.
 **/
export function removeBlock(themeDir, name) {

	const slug = nameToSlug(name);
	const manifest = partial.readManifest(themeDir, slug);
	if (!manifest) {
		log.error(`No partial named "${name}" is recorded in this theme. Run \`wonderpress block list\` to see what exists.`);
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

	const file = partial.manifestPath(themeDir, slug);
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

	const name = args._ && args._[2] ? args._[2] : args['--name'];
	if (!name) {
		log.error('No name provided. Usage: wonderpress block remove <Name>.');
		return false;
	}

	return removeBlock(themeDir, name);
}
