const shell = require('shelljs');


export async function setup() {

	console.log('Setting up WonderPress...');

	// Install `wp-cli` latest release
	if (!shell.which('wp')) {
		console.log('Downloading and installing WP CLI');
		shelljs.exec('curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar');
		shelljs.exec('mv wp-cli.phar wp-cli');
	}

}