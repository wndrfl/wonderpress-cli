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
	isPristineLegacySource,
	locateFence,
	regionsEqual,
	renderFencedRegion,
	renderLegacyPartialClassSource,
} from './partial-class.js';
import {
	PARTIAL_LOCK_DIR,
	blockRelPath,
	currentPartialHashes,
	readPartialLock,
} from './partial-lock.js';

/** Per-partial sync states, worst last. */
export const DRIFT_STATES = ['clean', 'pending', 'conflict'];

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
 * Two comparisons, reported together:
 *
 * - `issues` (the original, binary one): does each artifact match what sync
 *   would write from the manifest right now? Kept for callers that read it.
 * - `state` + `changes` (three-way, against the sync lock): what changed since
 *   the last sync, and who changed it. A manifest edit is `pending` (sync is
 *   owed and safe); an edit to machine-owned output (the class's fenced
 *   region, block.json) is `conflict` (sync would destroy it). Conflict wins.
 *   No lock yet is `pending`, never `clean`.
 *
 * `ok` is false when the generated files do not match the manifest or the
 * partial is in conflict, i.e. exactly when lint and check-drift fail. A
 * pending partial whose files still match (no lock yet, a reformatted
 * manifest) is ok: it is reported, not failed.
 *
 * @param {object} manifest Parsed partial manifest.
 * @param {string} themeDir Theme root.
 * @returns {{
 *   slug: string,
 *   ok: boolean,
 *   state: 'clean'|'pending'|'conflict',
 *   changes: Array<{ artifact: 'manifest'|'class'|'block', region: 'fence'|'file'|null, kind: string, state: 'pending'|'conflict', message: string }>,
 *   issues: Array<{ code: string, message: string }>,
 * }}
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
			state: 'pending',
			changes: [{ artifact: 'manifest', region: null, kind: 'invalid', state: 'pending', message: err.message }],
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

	const changes = lockChanges(manifest, themeDir, params, issues);
	const state = changes.some((c) => c.state === 'conflict')
		? 'conflict'
		: (changes.length ? 'pending' : 'clean');
	// A conflict can hide from the binary comparison (block.json's title edited
	// by hand still has the right attribute names), so it joins `issues` too:
	// callers that only read `ok`/`issues` must not see a conflict as healthy.
	for (const change of changes) {
		if (change.state === 'conflict') {
			issues.push({ code: 'conflict', message: change.message });
		}
	}

	return {
		slug,
		ok: issues.length === 0,
		state,
		changes,
		issues,
	};
}

function readClass(themeDir, rel) {
	return fs.readFileSync(resolveWithin(themeDir, rel), 'utf8');
}

/**
 * The three-way half of drift: compare on-disk hashes with the sync lock.
 *
 * @param {object} manifest
 * @param {string} themeDir
 * @param {object} params paramsFromManifest(manifest)
 * @param {Array<{ code: string }>} issues The binary comparison's findings.
 * @returns {Array<{ artifact: string, region: string|null, kind: string, state: 'pending'|'conflict', message: string }>}
 */
function lockChanges(manifest, themeDir, params, issues) {
	const slug = manifest.slug;
	const artifacts = manifest.artifacts || {};
	const sync = `wonderpress partial sync ${params.class_name}`;
	const lockRel = `${PARTIAL_LOCK_DIR}/${slug}.json`;
	const blockRel = blockRelPath(manifest);
	const hashes = currentPartialHashes(manifest, themeDir);
	const { lock, error: lockError } = readPartialLock(themeDir, slug);
	const changes = [];
	const pending = (artifact, region, kind, message) => changes.push({ artifact, region, kind, state: 'pending', message });
	const conflict = (artifact, region, kind, message) => changes.push({ artifact, region, kind, state: 'conflict', message });

	// A missing generated file is work sync owes, whatever the lock says.
	const missing = () => {
		if (artifacts.class && hashes.classFenceState === 'missing') {
			pending('class', 'file', 'missing', `Partial class ${artifacts.class} is missing. Run: ${sync}`);
		}
		if (params.emit.block && !hashes.block) {
			pending('block', 'file', 'missing', `${blockRel} is missing. Run: ${sync}`);
		}
	};

	if (!lock) {
		// A legacy partial (or one written by an older CLI) has no lock, so
		// there is no record of what sync last wrote and a hand edit cannot be
		// told from a manifest edit. Report pending with the binary result;
		// the first sync writes the lock.
		const matches = issues.length === 0;
		const why = lockError ? `${lockRel} is unreadable (${lockError})` : `No sync lock yet (${lockRel})`;
		pending(
			'manifest',
			null,
			lockError ? 'lock_invalid' : 'no_lock',
			`${why}; generated files ${matches ? 'match' : 'differ from'} the manifest. Run: ${sync} to ${matches ? 'record' : 'apply and record'} it.`,
		);
		missing();
		return changes;
	}

	if (hashes.manifest !== lock.manifest) {
		pending('manifest', null, 'edited', `Manifest changed since the last sync. Run: ${sync}`);
	}

	if (artifacts.class) {
		switch (hashes.classFenceState) {
			case 'unfenced':
				// Still exactly what the pre-fence template generated: nothing
				// human-written to lose, and sync migrates it without asking.
				if (isPristineLegacySource(readClass(themeDir, artifacts.class), params)) {
					pending('class', 'fence', 'legacy', `Partial class ${artifacts.class} predates fences; sync will add them. Run: ${sync}`);
					break;
				}
				conflict('class', 'fence', 'unfenced', `Partial class ${artifacts.class} lost its <wonderpress:generated> markers since the last sync. Restore them around the generated members in your editor, or re-run: ${sync} --force`);
				break;
			case 'malformed':
				conflict('class', 'fence', 'malformed', `Partial class ${artifacts.class} has malformed <wonderpress:generated> markers. Fix them in your editor, or re-run: ${sync} --force`);
				break;
			case 'ok':
				if (typeof lock.classFence !== 'string') {
					pending('class', 'fence', 'unrecorded', `The generated region of ${artifacts.class} is not in the sync lock. Run: ${sync}`);
				} else if (hashes.classFence !== lock.classFence) {
					conflict('class', 'fence', 'edited', `The generated region of ${artifacts.class} was edited since the last sync. Move custom code below the closing // </wonderpress:generated> line (or revert the edit) in your editor, or re-run: ${sync} --force to overwrite it.`);
				}
				break;
			default:
				break;
		}
	}

	if (params.emit.block && hashes.block) {
		if (typeof lock.block !== 'string') {
			// e.g. `block create` wrapped the partial after its last sync.
			pending('block', 'file', 'unrecorded', `${blockRel} is not in the sync lock. Run: ${sync}`);
		} else if (hashes.block !== lock.block) {
			conflict('block', 'file', 'edited', `${blockRel} was edited since the last sync; it is wholly generated. Put the change in the manifest (or revert it) in your editor, or re-run: ${sync} --force to overwrite it.`);
		}
	}

	missing();

	// Nothing changed since the last sync, yet sync would write something
	// different: the generator itself moved (a CLI upgrade). Owed, and safe.
	if (!changes.length && issues.length) {
		const classStale = issues.some((i) => i.code === 'class_drift');
		const blockStale = issues.some((i) => i.code.startsWith('block_'));
		if (classStale) {
			pending('class', 'fence', 'stale', `The generated region of ${artifacts.class} differs from what this CLI version writes, though nothing changed since the last sync. Run: ${sync}`);
		}
		if (blockStale) {
			pending('block', 'file', 'stale', `${blockRel} differs from what this CLI version writes, though nothing changed since the last sync. Run: ${sync}`);
		}
		// Every issue code is one of the above today; never let a new one
		// read as clean.
		if (!changes.length) {
			pending('manifest', null, 'stale', `Generated files differ from the manifest. Run: ${sync}`);
		}
	}

	return changes;
}
