const fs = require('fs-extra');
const rc = require('rc');

/**
 * Determine if a config file exists in a directory.
 **/
export async function exists(dir) {

  let config;

  // Check for .wonderpressrc
  let path = `${dir}/.wonderpressrc`;
  try {
    const data = fs.readFileSync(path);
    config = JSON.parse(data);
  } catch(err) {
    //
  }

  // Check for .wonderpress (old version)
  if(!config) {
    let path = `${dir}/.wonderpress`;
    try {
      const data = fs.readFileSync(path);
      config = JSON.parse(data);
    } catch(err) {
      //
    }
  }

  return config;
}

/**
 * Get a config in rc format (JSON is acceptable)
 **/
export async function get() {

  const config = rc('wonderpress', {
    //
  });

}
