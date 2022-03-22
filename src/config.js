const fs = require("fs");
const log = require("./log");

export async function get(dir) {

  let config;

  // Check for .wonderpressrc
  let path = `${dir}/.wonderpressrc`;
  try {
    const data = fs.readFileSync(path);
    config = JSON.parse(data);
  } catch(err) {
    // log.info(`No .wonderpressrc found.`);
  }

  // Check for .wonderpress (old version)
  if(!config) {
    let path = `${dir}/.wonderpress`;
    try {
      const data = fs.readFileSync(path);
      config = JSON.parse(data);
    } catch(err) {
      // log.info(`No .wonderpress found`);
    }
  }

  return config;
}
