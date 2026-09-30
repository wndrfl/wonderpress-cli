/**
 * Validate page-template manifests and check that composition rows are
 * rendered in the template PHP.
 *
 * The JSON Schema in the editor cannot know which partials exist, whether
 * instance ids collide, or whether the PHP prints the row. This module is
 * that check. `template validate` and `lint` both call it.
 */

import fs from 'fs-extra';
import path from 'path';
import {
	PARTIAL_MANIFEST_DIR,
	compositionRowIsFieldGroup,
	compositionRowIsTab,
	pageTemplateManifestDir,
	resolveWithin,
	validateTemplateManifest,
} from './validate.js';

/**
 * Drop PHP comments so scaffold examples (`// wonder_partial_props(...)`) are
 * not treated as real render calls. `https://` is left alone.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripPhpComments(source) {
	return String(source)
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/**
 * Render calls in a page template, after comments are removed.
 *
 * `wonder_partial_props( slug, id )` and `wonder_template_composition_field( id )`.
 * `wonder_render_template_sections()` covers every partial row and no field row.
 *
 * @param {string} source
 */
export function parseTemplateRenderCalls(source) {
	const code = stripPhpComments(source);
	const partials = [];
	const fields = [];
	const partialRe = /wonder_partial_props\s*\(\s*(['"])([a-z0-9-]+)\1\s*,\s*(['"])([a-z0-9-]+)\3/g;
	const fieldRe = /wonder_template_composition_field\s*\(\s*(['"])([a-z0-9-]+)\1/g;

	let match;
	while ((match = partialRe.exec(code)) !== null) {
		partials.push({ partial: match[2], id: match[4] });
	}
	while ((match = fieldRe.exec(code)) !== null) {
		fields.push({ id: match[2] });
	}

	return {
		partials,
		fields,
		rendersAllPartials: /wonder_render_template_sections\s*\(/.test(code),
	};
}

/**
 * Partial instances and inline field groups, in document order.
 * Tab rows themselves are not rendered.
 *
 * @param {unknown} composition
 */
export function declaredCompositionRows(composition) {
	const partials = [];
	const fields = [];

	function walk(rows, inTab) {
		if (!Array.isArray(rows)) {
			return;
		}
		for (const row of rows) {
			if (!row || typeof row !== 'object' || !row.id) {
				continue;
			}
			if (compositionRowIsTab(row)) {
				if (!inTab) {
					walk(row.items, true);
				}
				continue;
			}
			if (row.partial) {
				partials.push({ id: row.id, partial: row.partial });
				continue;
			}
			if (compositionRowIsFieldGroup(row)) {
				fields.push({ id: row.id });
			}
		}
	}

	walk(composition, false);
	return { partials, fields };
}

function readPartialSlugs(themeDir) {
	const dir = path.join(themeDir, PARTIAL_MANIFEST_DIR);
	if (!fs.existsSync(dir)) {
		return [];
	}
	const slugs = [];
	for (const file of fs.readdirSync(dir)) {
		if (!file.endsWith('.json')) {
			continue;
		}
		try {
			const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			if (typeof data?.slug === 'string' && data.slug) {
				slugs.push(data.slug);
			}
		} catch {
			// An unreadable partial manifest is not a slug.
		}
	}
	return slugs;
}

function issueList() {
	const issues = [];
	const seen = new Set();
	return {
		issues,
		add(code, message) {
			const key = `${code}\0${message}`;
			if (seen.has(key)) {
				return;
			}
			seen.add(key);
			issues.push({ code, message });
		},
	};
}

/**
 * Compare composition rows to render calls in the template PHP.
 *
 * @param {string} themeDir
 * @param {object} data Parsed manifest.
 */
export function templateRenderDrift(themeDir, data) {
	const found = issueList();
	if (!data?.template || typeof data.template !== 'string') {
		return found.issues;
	}
	if (data.composition !== undefined && !Array.isArray(data.composition)) {
		return found.issues;
	}

	const phpPath = resolveWithin(themeDir, data.template);
	if (!phpPath) {
		found.add('path', `Template path "${data.template}" escapes the theme directory.`);
		return found.issues;
	}

	const declared = declaredCompositionRows(data.composition);
	if (!fs.existsSync(phpPath)) {
		found.add('missing_php', `Template file "${data.template}" does not exist.`);
		return found.issues;
	}

	const calls = parseTemplateRenderCalls(fs.readFileSync(phpPath, 'utf8'));
	const phpName = data.template;

	for (const row of declared.partials) {
		const rendered = calls.rendersAllPartials || calls.partials.some((call) => (
			call.id === row.id && call.partial === row.partial
		));
		if (!rendered) {
			found.add(
				'unrendered_partial',
				`Composition row "${row.id}" (${row.partial}) is not rendered. In ${phpName}, call wonder_partial_props( '${row.partial}', '${row.id}' ).`,
			);
		}
	}

	for (const row of declared.fields) {
		if (!calls.fields.some((call) => call.id === row.id)) {
			found.add(
				'unrendered_fields',
				`Composition row "${row.id}" is not read. In ${phpName}, call wonder_template_composition_field( '${row.id}' ).`,
			);
		}
	}

	for (const call of calls.partials) {
		if (!declared.partials.some((row) => row.id === call.id && row.partial === call.partial)) {
			found.add(
				'undeclared_partial',
				`wonder_partial_props( '${call.partial}', '${call.id}' ) in ${phpName} has no composition row.`,
			);
		}
	}

	for (const call of calls.fields) {
		if (!declared.fields.some((row) => row.id === call.id)) {
			found.add(
				'undeclared_fields',
				`wonder_template_composition_field( '${call.id}' ) in ${phpName} has no composition row.`,
			);
		}
	}

	return found.issues;
}

function checkOne(themeDir, file, partialSlugs) {
	const manifestFile = path.basename(file);
	let raw;
	try {
		raw = fs.readFileSync(file, 'utf8');
	} catch (err) {
		return {
			template: manifestFile,
			manifestFile,
			ok: false,
			issues: [{ code: 'read', message: `Could not read ${manifestFile}: ${err.message}` }],
		};
	}

	let data;
	try {
		data = JSON.parse(raw);
	} catch (err) {
		return {
			template: manifestFile,
			manifestFile,
			ok: false,
			issues: [{ code: 'json', message: `${manifestFile} is not valid JSON (${err.message}).` }],
		};
	}

	const found = issueList();
	const validated = validateTemplateManifest(data, { partialSlugs, checkPartialSlugs: true });
	if (!validated.ok) {
		for (const message of validated.errors) {
			found.add('manifest', message);
		}
	}
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		for (const issue of templateRenderDrift(themeDir, data)) {
			found.add(issue.code, issue.message);
		}
	}

	const template = data && typeof data.template === 'string' ? data.template : manifestFile;
	return {
		template,
		manifestFile,
		ok: found.issues.length === 0,
		issues: found.issues,
	};
}

/**
 * Validate every page-template manifest in a theme, or an explicit file list.
 *
 * @param {string} themeDir
 * @param {{ manifestPaths?: string[]|null }} [opts]
 * @returns {{ ok: boolean, results: object[] }}
 */
export function checkPageTemplates(themeDir, { manifestPaths = null } = {}) {
	let files = manifestPaths;
	if (!files) {
		const dir = pageTemplateManifestDir(themeDir);
		if (!fs.existsSync(dir)) {
			return { ok: true, results: [] };
		}
		files = fs.readdirSync(dir)
			.filter((name) => name.endsWith('.json'))
			.sort()
			.map((name) => path.join(dir, name));
	}

	const partialSlugs = readPartialSlugs(themeDir);
	const results = files.map((file) => checkOne(themeDir, file, partialSlugs));
	return {
		ok: results.every((result) => result.ok),
		results,
	};
}
