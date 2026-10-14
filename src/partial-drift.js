/**
 * Detect drift between partial manifests and generated artifacts (class, block.json).
 */

import fs from 'fs-extra';
import path from 'path';
import {
	defaultTemplateName,
	normalizeProperty,
	PROP_TYPE_TO_BLOCK,
	resolveWithin,
} from './validate.js';
import {
	locateFence,
	regionsEqual,
	renderFencedRegion,
	renderLegacyPartialClassSource,
} from './partial-class.js';

/** @param {object} manifest */
function paramsFromManifest(manifest) {
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
			style: !!artifacts.style,
			script: !!artifacts.script,
		},
	};
}

/**
 * Property names declared in a generated partial class $properties block.
 * Also matches classes that still declare the legacy $_properties name.
 *
 * @param {string} source PHP file contents.
 * @returns {string[]}
 */
export function parseClassPropertyNames(source) {
	const names = [];
	const re = /^\s+'([a-zA-Z0-9_]+)'\s*=>\s*array\s*\(/gm;
	let match;
	while ((match = re.exec(source)) !== null) {
		names.push(match[1]);
	}
	return names;
}

function sortedUnique(list) {
	return [...new Set(list)].sort();
}

function setDiff(missing, extra) {
	return {
		missing: missing.sort(),
		extra: extra.sort(),
	};
}

/**
 * Compare manifest contract to on-disk class and block.json.
 *
 * @param {object} manifest Parsed partial manifest.
 * @param {string} themeDir Theme root.
 * @returns {{ slug: string, ok: boolean, issues: Array<{ code: string, message: string }> }}
 */
export function checkPartialDrift(manifest, themeDir) {
	const issues = [];
	const slug = manifest.slug;
	const artifacts = manifest.artifacts || {};
	let params;

	try {
		params = paramsFromManifest(manifest);
	} catch (err) {
		return {
			slug,
			ok: false,
			issues: [{ code: 'manifest', message: err.message }],
		};
	}

	const expectedProps = sortedUnique(
		params.properties.filter((p) => p?.name).map((p) => p.name),
	);

	if (artifacts.class) {
		const classFile = resolveWithin(themeDir, artifacts.class);
		if (!classFile || !fs.existsSync(classFile)) {
			issues.push({
				code: 'class_missing',
				message: `Partial class not found at ${artifacts.class}. Run: wonderpress partial sync ${params.class_name}`,
			});
		} else {
			const onDisk = fs.readFileSync(classFile, 'utf8');
			// Fence contract: only the generated region is machine-owned, so a
			// fenced file is compared region to region and edits outside it
			// (custom methods) are never drift. An unfenced legacy file keeps
			// the whole-file comparison against what the pre-fence template
			// generated; sync migrates it to fences.
			let fence = null;
			let fenceError = null;
			try {
				fence = locateFence(onDisk);
			} catch (err) {
				fenceError = err;
			}
			let compared = onDisk;
			let inSync;
			if (fenceError) {
				inSync = false;
			} else if (fence) {
				compared = onDisk.slice(fence.start, fence.end);
				inSync = regionsEqual(compared, renderFencedRegion(params));
			} else {
				inSync = regionsEqual(onDisk, renderLegacyPartialClassSource(params));
			}
			if (fenceError) {
				issues.push({
					code: 'class_drift',
					message: `Partial class ${artifacts.class} has malformed <wonderpress:generated> markers (${fenceError.message}). Fix the markers, or regenerate: wonderpress partial sync ${params.class_name} --force`,
				});
			} else if (!inSync) {
				const onDiskKeys = sortedUnique(parseClassPropertyNames(compared));
				const keyDiff = setDiff(
					expectedProps.filter((k) => !onDiskKeys.includes(k)),
					onDiskKeys.filter((k) => !expectedProps.includes(k)),
				);
				let detail = fence
					? 'Generated region of the partial class differs from manifest (edited inside the fence, or sync needed).'
					: 'Partial class differs from manifest (hand-edited or sync needed).';
				if (keyDiff.missing.length || keyDiff.extra.length) {
					const parts = [];
					if (keyDiff.missing.length) {
						parts.push(`missing in class: ${keyDiff.missing.join(', ')}`);
					}
					if (keyDiff.extra.length) {
						parts.push(`extra in class: ${keyDiff.extra.join(', ')}`);
					}
					detail += ` Property keys — ${parts.join('; ')}.`;
				}
				issues.push({
					code: 'class_drift',
					message: `${detail} Fix: wonderpress partial sync ${params.class_name}`,
				});
			}
		}
	}

	if (params.emit.block) {
		const blockPath = artifacts.block
			? resolveWithin(themeDir, artifacts.block)
			: resolveWithin(themeDir, `blocks/${slug}/block.json`);
		if (!blockPath || !fs.existsSync(blockPath)) {
			issues.push({
				code: 'block_missing',
				message: `block.json missing for dual partial. Run: wonderpress partial sync ${params.class_name}`,
			});
		} else {
			let block;
			try {
				block = JSON.parse(fs.readFileSync(blockPath, 'utf8'));
			} catch (e) {
				issues.push({ code: 'block_invalid', message: `Could not parse ${artifacts.block || blockPath}: ${e.message}` });
			}
			if (block?.attributes) {
				const onDiskAttrs = sortedUnique(Object.keys(block.attributes));
				const expectedAttrs = sortedUnique(expectedProps);
				const missing = expectedAttrs.filter((k) => !onDiskAttrs.includes(k));
				const extra = onDiskAttrs.filter((k) => !expectedAttrs.includes(k));
				if (missing.length || extra.length) {
					const parts = [];
					if (missing.length) {
						parts.push(`missing in block.json: ${missing.join(', ')}`);
					}
					if (extra.length) {
						parts.push(`extra in block.json: ${extra.join(', ')}`);
					}
					issues.push({
						code: 'block_drift',
						message: `block.json attributes out of sync with manifest (${parts.join('; ')}). Run: wonderpress partial sync ${params.class_name}`,
					});
				} else {
					for (const prop of params.properties) {
						const attr = block.attributes[prop.name];
						const expectedType = PROP_TYPE_TO_BLOCK[prop.type] || 'string';
						if (attr && attr.type !== expectedType) {
							issues.push({
								code: 'block_type',
								message: `block.json attribute "${prop.name}" type is "${attr.type}", manifest expects "${expectedType}". Run: wonderpress partial sync ${params.class_name}`,
							});
						}
					}
				}
			}
		}
	}

	return {
		slug,
		ok: issues.length === 0,
		issues,
	};
}
