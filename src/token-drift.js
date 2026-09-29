/**
 * Detect drift between Static Kit token files and the names theme.json bridges.
 *
 * Static Kit consumes `--color-*`, `--font-*`, and `--type-*`. wonderpress-core
 * prints those names from theme.json. This check fails when the two sets
 * disagree, so a Static Kit bump that renames a token does not fall back silently.
 */

import fs from 'fs-extra';
import path from 'path';

/**
 * Kebab-case one settings key the way WordPress flattens custom properties.
 *
 * Matches `wonder_token_bridge_kebab()` in wonderpress-core.
 *
 * @param {string} key
 * @returns {string}
 */
export function kebab(key) {
	return String(key)
		.replace(/([a-z0-9])([A-Z])/g, '$1-$2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
		.toLowerCase()
		.replace(/[/_]/g, '-');
}

/**
 * Flatten a settings tree into WordPress custom-property paths.
 *
 * `{ h2: { sizeTablet: '3rem' } }` becomes `['h2--size-tablet']`.
 *
 * @param {object} tree
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function flattenTree(tree, prefix = '') {
	const paths = [];
	if (!tree || typeof tree !== 'object' || Array.isArray(tree)) {
		return paths;
	}
	for (const [property, value] of Object.entries(tree)) {
		const segment = kebab(property).replaceAll('/', '-');
		const next = prefix + segment;
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			paths.push(...flattenTree(value, `${next}--`));
		} else {
			paths.push(next);
		}
	}
	return paths;
}

/**
 * Preset slugs from a flat list, or from the theme origin of an origin-keyed list.
 *
 * Core's `default` bucket is ignored, matching the PHP bridge.
 *
 * @param {Array|object|undefined} presets
 * @returns {string[]}
 */
export function presetSlugs(presets) {
	if (!presets || typeof presets !== 'object') {
		return [];
	}
	let list = presets;
	if (!Array.isArray(presets)) {
		const keys = Object.keys(presets);
		const origins = ['theme', 'default', 'custom'];
		if (keys.length && keys.every((key) => origins.includes(key))) {
			list = Array.isArray(presets.theme) ? presets.theme : [];
		} else {
			return [];
		}
	}
	return list
		.filter((preset) => preset && typeof preset.slug === 'string' && preset.slug !== '')
		.map((preset) => kebab(preset.slug))
		.filter((slug) => slug !== '');
}

/**
 * Custom property names the token bridge would print for these settings.
 *
 * @param {object} settings theme.json `settings`.
 * @returns {Set<string>}
 */
export function bridgeNames(settings) {
	const names = new Set();
	const color = settings?.color?.palette;
	for (const slug of presetSlugs(color)) {
		names.add(`--color-${slug}`);
	}
	const families = settings?.typography?.fontFamilies;
	for (const slug of presetSlugs(families)) {
		names.add(`--font-${slug}`);
	}
	for (const leaf of flattenTree(settings?.custom?.type)) {
		names.add(`--type-${leaf.replaceAll('--', '-')}`);
	}
	for (const leaf of flattenTree(settings?.custom?.color)) {
		names.add(`--color-${leaf.replaceAll('--', '-')}`);
	}
	return names;
}

/**
 * Custom property names assigned in a token Sass file.
 *
 * Matches `$id: var(--name, …)`. The name is the first argument; commas inside
 * the fallback are CSS, not extra arguments.
 *
 * @param {string} source
 * @returns {Set<string>}
 */
export function consumedNames(source) {
	const names = new Set();
	const pattern = /\$[\w-]+:\s*var\(\s*(--[\w-]+)/g;
	for (const match of source.matchAll(pattern)) {
		names.add(match[1]);
	}
	return names;
}

/**
 * Compare bridge names to the names token files consume.
 *
 * @param {{ settings: object, sources: string[] }} input
 * @returns {{ ok: boolean, issues: Array<{ code: string, name?: string, message: string }> }}
 */
export function checkTokenDrift({ settings, sources }) {
	const bridged = bridgeNames(settings || {});
	const consumed = new Set();
	for (const source of sources || []) {
		for (const name of consumedNames(source)) {
			consumed.add(name);
		}
	}

	const issues = [];
	for (const name of [...consumed].filter((item) => !bridged.has(item)).sort()) {
		issues.push({
			code: 'unbridged',
			name,
			message: `${name} is consumed by Static Kit and has no theme.json slot`,
		});
	}
	for (const name of [...bridged].filter((item) => !consumed.has(item)).sort()) {
		issues.push({
			code: 'stale',
			name,
			message: `${name} is declared in theme.json and no token file consumes it`,
		});
	}

	return { ok: issues.length === 0, issues };
}

/**
 * Read a theme's token files and theme.json and compare them.
 *
 * Skips themes that have not installed Static Kit (`static/src/scss/lib/tokens`
 * absent). An empty token directory with a theme.json still reports stale slots.
 *
 * @param {string} themeDir
 * @returns {{ ok: boolean, skipped?: boolean, issues: Array<{ code: string, name?: string, message: string }> }}
 */
export function checkThemeTokenDrift(themeDir) {
	const tokenDir = path.join(themeDir, 'static/src/scss/lib/tokens');
	if (!fs.existsSync(tokenDir)) {
		return { ok: true, skipped: true, issues: [] };
	}

	let settings = {};
	const themeJsonPath = path.join(themeDir, 'theme.json');
	if (fs.existsSync(themeJsonPath)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(themeJsonPath, 'utf8'));
			settings = parsed.settings || {};
		} catch (err) {
			return {
				ok: false,
				issues: [{
					code: 'theme_json',
					message: `theme.json could not be parsed: ${err.message}`,
				}],
			};
		}
	}

	const sources = fs.readdirSync(tokenDir)
		.filter((file) => file.endsWith('.scss'))
		.sort()
		.map((file) => fs.readFileSync(path.join(tokenDir, file), 'utf8'));

	return checkTokenDrift({ settings, sources });
}
