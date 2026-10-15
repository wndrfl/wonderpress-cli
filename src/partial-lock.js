/**
 * Sync locks: what each partial's machine-owned artifacts looked like the last
 * time sync wrote them.
 *
 * One file per partial at `.wonderpress/manifest/partials/<slug>.lock.json`,
 * committed with the theme:
 *
 *   {
 *     "manifest":          sha256 of the manifest file as sync left them,
 *     "classFence":        sha256 of the class's fenced region as written,
 *     "classFenceContent": that fenced region verbatim,
 *     "block":             sha256 of block.json bytes as written (absent without a block),
 *     "blockContent":      block.json verbatim,
 *     "cliVersion":        the CLI version that wrote the lock
 *   }
 *
 * The hashes turn drift from a binary "differs from what sync would write"
 * into a three-way comparison: a changed manifest hash means the user edited
 * the contract and sync is owed (pending); a changed class-fence or block.json
 * hash means someone edited machine-owned output by hand (conflict), which a
 * sync would silently destroy.
 *
 * The `*Content` fields are carried data, not comparison: nothing here or in
 * partial-drift.js keys off them. They are the merge base a conflict-resolve
 * UI needs — a hash says output was edited but cannot say what it was edited
 * from. They are written every time and read as optional, so a lock from
 * before they existed still works everywhere.
 *
 * Per-partial files rather than one lock, and beside the manifest rather than
 * inside it: the lock is the manifest's sidecar (package-lock.json beside
 * package.json), so two branches touching different partials never conflict on
 * the lock, and the hand-edited manifest does not churn every time a hash
 * moves. Locks are never manifests — readers of the manifest directory skip
 * `*.lock.json` (`isPartialLockFilename`), and no manifest schema covers them.
 *
 * Like partial-class.js, this imports nothing from partial.js (partial.js
 * imports partial-drift.js, which imports this).
 */

import { createHash } from 'node:crypto';
import fs from 'fs-extra';
import path from 'path';
import {
	PARTIAL_LOCK_SUFFIX,
	PARTIAL_MANIFEST_DIR,
	partialManifestPath,
	resolveWithin,
} from './validate.js';
import { extractFencedRegion } from './partial-class.js';
import pkg from '../package.json' with { type: 'json' };

/**
 * @param {string | Buffer} bytes
 * @returns {string} Hex sha256.
 */
export function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The hash a lock records for a file's content: sha256 of its exact bytes,
 * with one exception, CRLF line endings count as LF. The lock is committed, so
 * it must survive git's autocrlf: a Windows checkout turns every generated
 * file into CRLF, and hashing raw bytes would report each one as hand-edited
 * (a conflict that blocks sync) although nobody touched it. The fence writer
 * already treats CRLF and LF as equal for the same reason (regionsEqual).
 * Nothing else is normalized: whitespace, key order, and trailing newlines
 * all count.
 *
 * @param {string | Buffer} content
 * @returns {string}
 */
export function contentHash(content) {
	const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
	return sha256(text.replace(/\r\n/g, '\n'));
}

/**
 * Theme-relative path of a partial's lock, for messages.
 *
 * @param {string} slug
 * @returns {string}
 */
export function partialLockRelPath(slug) {
	return `${PARTIAL_MANIFEST_DIR}/${slug}${PARTIAL_LOCK_SUFFIX}`;
}

/**
 * @param {string} themeDir
 * @param {string} slug
 * @returns {string}
 */
export function partialLockPath(themeDir, slug) {
	return path.join(themeDir, PARTIAL_MANIFEST_DIR, `${slug}${PARTIAL_LOCK_SUFFIX}`);
}

/**
 * Theme-relative path of a partial's block.json. Mirrors where writeBlock()
 * puts it; a manifest that records artifacts.block wins.
 *
 * @param {object} manifest
 * @returns {string}
 */
export function blockRelPath(manifest) {
	const artifacts = manifest.artifacts || {};
	return artifacts.block || `blocks/${manifest.slug}/block.json`;
}

/**
 * Read a partial's lock. Quiet by design: drift reports a missing or unreadable
 * lock as a state, so this never logs.
 *
 * @param {string} themeDir
 * @param {string} slug
 * @returns {{ lock: object | null, error: string | null }}
 */
export function readPartialLock(themeDir, slug) {
	const file = partialLockPath(themeDir, slug);
	if (!fs.existsSync(file)) {
		return { lock: null, error: null };
	}
	try {
		const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (!lock || typeof lock !== 'object' || Array.isArray(lock) || typeof lock.manifest !== 'string') {
			return { lock: null, error: 'it is not a lock object with a "manifest" hash' };
		}
		return { lock, error: null };
	} catch (err) {
		return { lock: null, error: err.message };
	}
}

/**
 * Hashes of a partial's artifacts as they are on disk right now. Each hash is
 * null when its file is absent; `classFence` is also null when the class has
 * no (or malformed) fence markers, with the reason in `classFenceState`.
 *
 * The hashes are over exact content (CRLF reads as LF; see contentHash). The
 * class is the one interpretation: its hash covers the fenced region text
 * extractFencedRegion() returns, because everything outside the fence is the
 * user's and may change freely.
 *
 * `classFenceContent` and `blockContent` are the same two artifacts verbatim,
 * byte for byte as they are on disk — not CRLF-normalized the way the hashes
 * beside them are, because a merge base has to be the real text. They are what
 * writePartialLock() carries into the lock; nothing compares them.
 *
 * @param {object} manifest Parsed manifest (supplies slug and artifact paths).
 * @param {string} themeDir
 * @returns {{
 *   manifest: string | null,
 *   classFence: string | null,
 *   classFenceContent: string | null,
 *   classFenceState: 'ok' | 'missing' | 'unfenced' | 'malformed' | 'none',
 *   block: string | null,
 *   blockContent: string | null,
 * }}
 */
export function currentPartialHashes(manifest, themeDir) {
	const artifacts = manifest.artifacts || {};
	const manifestFile = partialManifestPath(themeDir, manifest.slug);
	const out = {
		manifest: fs.existsSync(manifestFile) ? contentHash(fs.readFileSync(manifestFile)) : null,
		classFence: null,
		classFenceContent: null,
		classFenceState: 'none',
		block: null,
		blockContent: null,
	};

	if (artifacts.class) {
		const classFile = resolveWithin(themeDir, artifacts.class);
		if (!classFile || !fs.existsSync(classFile)) {
			out.classFenceState = 'missing';
		} else {
			let region = null;
			try {
				region = extractFencedRegion(fs.readFileSync(classFile, 'utf8'));
				out.classFenceState = region === null ? 'unfenced' : 'ok';
			} catch {
				out.classFenceState = 'malformed';
			}
			if (region !== null) {
				out.classFence = contentHash(region);
				out.classFenceContent = region;
			}
		}
	}

	const blockFile = resolveWithin(themeDir, blockRelPath(manifest));
	if (blockFile && fs.existsSync(blockFile)) {
		const blockSource = fs.readFileSync(blockFile, 'utf8');
		out.block = contentHash(blockSource);
		out.blockContent = blockSource;
	}

	return out;
}

/**
 * Record the current state of a partial's artifacts as its last sync. Called
 * by sync and create right after they write, so the hashes are of exactly
 * what they wrote.
 *
 * @param {object} manifest Parsed manifest (slug, artifacts, block).
 * @param {string} themeDir
 * @returns {{ path: string, lock: object }}
 */
export function writePartialLock(manifest, themeDir) {
	const hashes = currentPartialHashes(manifest, themeDir);
	const lock = { manifest: hashes.manifest };
	if (hashes.classFence) {
		lock.classFence = hashes.classFence;
		lock.classFenceContent = hashes.classFenceContent;
	}
	// block.json is only part of the contract when the partial is a block; a
	// stray file left by a removed wrapper is not recorded.
	if (manifest.block && hashes.block) {
		lock.block = hashes.block;
		lock.blockContent = hashes.blockContent;
	}
	lock.cliVersion = pkg.version;
	const file = partialLockPath(themeDir, manifest.slug);
	fs.ensureDirSync(path.dirname(file));
	fs.writeFileSync(file, JSON.stringify(lock, null, 2) + '\n');
	return { path: file, lock };
}

/**
 * Delete a partial's lock (partial remove). Returns whether one existed.
 *
 * @param {string} themeDir
 * @param {string} slug
 * @returns {boolean}
 */
export function removePartialLock(themeDir, slug) {
	const file = resolveWithin(themeDir, partialLockRelPath(slug));
	if (!file || !fs.existsSync(file)) {
		return false;
	}
	fs.removeSync(file);
	return true;
}
