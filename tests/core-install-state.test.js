import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretCoreIsInstalled } from '../src/wordpress.js';

/**
 * `wp core is-installed` exits 1 for two different situations, and only one of
 * them is "WordPress is not installed". The other is a shell that cannot open
 * the database — a restricted sandbox against a site that is installed and
 * running — and telling the reader to install WordPress there is a lie.
 **/

const DB_ERROR = [
	'Warning: mysqli_real_connect(): (HY000/2002): Connection refused in /var/www/html/wp-includes/class-wpdb.php on line 1990',
	'Error: Error establishing a database connection. This either means that the username and password information in your `wp-config.php` file is incorrect or that contact with the database server at `localhost` could not be established. This could mean your host’s database server is down.',
].join('\n');

test('a zero exit means WordPress is installed', () => {
	const state = interpretCoreIsInstalled({ code: 0, stdout: '', stderr: '' });
	assert.equal(state.installed, true);
	assert.equal(state.unreachable, false);
	assert.equal(state.message, null);
});

test('a bare non-zero exit means WordPress is not installed', () => {
	const state = interpretCoreIsInstalled({ code: 1, stdout: '', stderr: '' });
	assert.equal(state.installed, false);
	assert.equal(state.unreachable, false);
	assert.match(state.message, /not installed/);
	assert.equal(state.hint, null);
});

test('a database error is reported as unreachable, with the host WP-CLI named', () => {
	const state = interpretCoreIsInstalled({ code: 1, stdout: '', stderr: DB_ERROR });
	assert.equal(state.installed, false);
	assert.equal(state.unreachable, true);
	assert.match(state.message, /database server at `localhost`/);
	assert.doesNotMatch(state.message, /^Error:/);
	assert.match(state.hint, /restricted shell/);
	assert.match(state.hint, /--theme/);
});

test('a mysqli warning with no Error line still counts as unreachable', () => {
	const state = interpretCoreIsInstalled({
		code: 1,
		stdout: '',
		stderr: 'Warning: mysqli_real_connect(): getaddrinfo for mysql failed',
	});
	assert.equal(state.unreachable, true);
	assert.match(state.message, /cannot reach the database/);
});
