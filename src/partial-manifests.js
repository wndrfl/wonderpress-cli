/**
 * Core-bundled partial manifests (primitives shipped with wonderpress-core).
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { partialManifestPath } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Slugs with a canonical manifest inside wonderpress-core. */
export const CORE_PARTIAL_MANIFEST_SLUGS = ['link'];

/**
 * Resolve the path to a bundled partial manifest JSON file.
 *
 * @param {string|null} themeDir Active theme directory (checks vendor path).
 * @param {string} slug Partial slug.
 * @returns {string|null}
 */
export function resolveCoreBundledPartialManifest(themeDir, slug) {
	const roots = [];
	if (themeDir) {
		roots.push(path.join(themeDir, 'vendor/wndrfl/wonderpress-core/wonderpress-core'));
	}
	roots.push(path.join(__dirname, '../../wonderpress-core/wonderpress-core'));

	for (const root of roots) {
		const candidate = path.join(root, 'manifest/partials', `${slug}.json`);
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

/**
 * Copy a core primitive manifest into the theme manifest index.
 *
 * @param {string} themeDir Theme root.
 * @param {string} slug Partial slug (e.g. link).
 * @returns {string|null} Destination path, or null when the source is missing.
 */
export function installCorePartialManifest(themeDir, slug) {
	const source = resolveCoreBundledPartialManifest(themeDir, slug);
	if (!source) {
		return null;
	}

	const dest = partialManifestPath(themeDir, slug);
	fs.ensureDirSync(path.dirname(dest));
	fs.copyFileSync(source, dest);
	return dest;
}
