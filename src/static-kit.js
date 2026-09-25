import fs from 'fs-extra';
import path from 'node:path';

/** Files Static Kit itself reads as proof of an existing installation. */
export const STATIC_KIT_CONFIGS = ['.staticrc', '.static', 'statickit.json'];

/**
 * Theme `static/` directory Static Kit owns.
 **/
export function staticKitDir(themeDir) {
	return path.join(themeDir, 'static');
}

/**
 * True when `dir` looks like an installed Static Kit tree.
 **/
export function isStaticKitTree(dir) {
	return STATIC_KIT_CONFIGS.some((file) => fs.existsSync(path.join(dir, file)));
}

/**
 * Lazy-load Static Kit so MCP/read paths never pull sharp at process startup.
 **/
export async function importStaticKit() {
	return import('@wndrfl/static-kit-cli');
}

/**
 * Install Static Kit into `dir` and compile it.
 *
 * Static Kit 3.0 keys install off a config file, merges into a seeded
 * directory, and does not chdir. This wrapper is a thin compile-after-install.
 **/
export async function installStaticKit(staticCli, dir, opts = {}) {
	const target = path.resolve(dir);
	const installed = await staticCli.core.installKit(target, { ...opts, compile: false });
	if (installed && installed.ok === false) {
		return installed;
	}
	return compileStatic(target, { staticCli });
}

/**
 * Compile (and optionally watch) a Static Kit tree.
 **/
export async function compileStatic(dir, { watch = false, staticCli = null } = {}) {
	const target = path.resolve(dir);
	if (!isStaticKitTree(target)) {
		return {
			ok: false,
			error: {
				code: 'static',
				message: `No Static Kit tree at ${target}.`,
				hint: 'Run `wonderpress init`, or pass --theme for the theme that owns static/.',
			},
		};
	}

	const kit = staticCli || await importStaticKit();
	const result = await kit.compile.all({ dir: target, watch });
	if (result && result.ok === false) {
		return result;
	}
	return { ok: true, data: { dir: target, watch: !!watch } };
}
