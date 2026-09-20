/**
 * Core-bundled partial manifests (primitives shipped with wonderpress-core).
 */

import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const PARTIAL_MANIFEST_REL = '.wonderpress/manifest/partials';

function themePartialManifestPath(themeDir, slug) {
	return path.join(themeDir, PARTIAL_MANIFEST_REL, `${slug}.json`);
}

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
	// Monorepo dev checkout (wonderpress-main).
	roots.push(path.join(__dirname, '../../wonderpress-core/wonderpress-core'));
	// Shipped with wonderpress-cli (npm / global install).
	roots.push(path.join(__dirname, '..'));

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

	const dest = themePartialManifestPath(themeDir, slug);
	fs.ensureDirSync(path.dirname(dest));
	fs.copyFileSync(source, dest);
	return dest;
}

/**
 * Property list for a partial embed (`type: partial`), theme manifest first then core bundle.
 *
 * @param {string|null} themeDir Theme root.
 * @param {string} slug Referenced partial slug.
 * @returns {import('./validate.js').ManifestProperty[]|null}
 */
export function readPartialEmbedProperties(themeDir, slug) {
	const safeSlug = String(slug || '').trim();
	if (!safeSlug) {
		return null;
	}

	if (themeDir) {
		const themePath = themePartialManifestPath(themeDir, safeSlug);
		if (fs.existsSync(themePath)) {
			try {
				const manifest = JSON.parse(fs.readFileSync(themePath, 'utf8'));
				if (Array.isArray(manifest?.properties) && manifest.properties.length) {
					return manifest.properties;
				}
			} catch {
				return null;
			}
		}
	}

	const bundled = resolveCoreBundledPartialManifest(themeDir, safeSlug);
	if (!bundled) {
		return null;
	}

	try {
		const manifest = JSON.parse(fs.readFileSync(bundled, 'utf8'));
		if (Array.isArray(manifest?.properties) && manifest.properties.length) {
			return manifest.properties;
		}
	} catch {
		return null;
	}

	return null;
}
