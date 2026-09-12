import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';
import rc from 'rc';

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
 * Get a config in rc format (JSON is acceptable)
 **/
export async function get() {

  const config = rc('wonderpress', {
    //
  });

}
