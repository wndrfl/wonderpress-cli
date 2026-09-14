import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';

/**
 * Is this path a file? Directories and missing paths are both false.
 **/
function isFile(path) {
  const stat = fs.statSync(path, { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

/**
 * Determine if a config file exists in a directory.
 *
 * Both markers must be *files*. `.wonderpress` especially: the CLI writes a
 * `.wonderpress/manifest/` directory into every theme it touches, and
 * existsSync() is true for a directory — so an existence check alone makes
 * every theme look like an environment root, and a walk up from
 * `themes/wonderpress/partials` stops at the theme instead of the environment.
 **/
export async function exists(dir) {

  // Check for .wonderpressrc
  if (isFile(`${dir}/.wonderpressrc`)) return true;

  // Check for .wonderpress (old version)
  if (isFile(`${dir}/.wonderpress`)) return true;

  return false;
}

/**
 * Which config file a directory uses, if any.
 **/
function markerPath(root) {

  const current = path.join(root, '.wonderpressrc');
  if (isFile(current)) return current;

  const legacy = path.join(root, '.wonderpress');
  if (isFile(legacy)) return legacy;

  return null;
}

/**
 * Read an environment's config file.
 *
 * Reads exactly `<root>/.wonderpressrc` (then the legacy `.wonderpress`) as
 * JSON. Deliberately NOT `rc`: rc merges `~/.wonderpressrc`, `wonderpress_*`
 * environment variables, every file found walking up from cwd, AND
 * `process.argv` via minimist — so `wonderpress partial create --name Hero`
 * would inject `name: 'Hero'` into the config object, and one developer's home
 * directory could silently change every project's settings.
 *
 * -> { format: 'json' | 'unparseable' | 'missing', file, data }
 **/
export function read(root) {

  const file = markerPath(root);

  if (!file) {
    return { format: 'missing', file: null, data: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { format: 'json', file, data: (data && typeof data === 'object') ? data : {} };
  } catch (e) {
    // The file is legitimately allowed to be INI — `rc` accepts either — so an
    // unparseable file is not corrupt, just not ours to rewrite.
    return { format: 'unparseable', file, data: {} };
  }
}

/**
 * Shallow-merge a patch into an environment's config file and write it back.
 *
 * Refuses rather than clobbering a file it could not parse. Returns whether it
 * wrote.
 **/
export function write(root, patch) {

  const existing = read(root);

  if (existing.format === 'unparseable') {
    log.warn(`Could not update ${existing.file} — it is not JSON, so it has been left alone.`);
    return false;
  }

  const file = existing.file || path.join(root, '.wonderpressrc');
  const merged = { ...existing.data, ...patch };

  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');

  return true;
}

/**
 * The environment backend this project was built with, or null.
 **/
export function getBackend(root) {
  const { data } = read(root);
  return (data && data.environment && data.environment.backend) || null;
}
