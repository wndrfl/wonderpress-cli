const fs = require('fs-extra');
const rc = require('rc');

/**
 * Determine if a config file exists in a directory.
 **/
export async function exists(dir) {

  let config;

  // Check for .wonderpressrc
  let path = `${dir}/.wonderpressrc`;
  if (await fs.existsSync(path)) return true;

  // Check for .wonderpress (old version)
  path = `${dir}/.wonderpress`;
  if (await fs.existsSync(path)) return true;

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
