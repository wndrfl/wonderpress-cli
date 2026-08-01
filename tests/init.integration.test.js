import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import mysql2 from 'mysql2/promise';
import * as wordpress from '../src/wordpress.js';

// Gated: only runs when WP_INTEGRATION is set AND the machine has wp-cli + MySQL.
// Exercises the headless configure + install path against a real database.
const RUN = !!process.env.WP_INTEGRATION;

const DB_HOST = process.env.WP_DB_HOST || '127.0.0.1';
const DB_USER = process.env.WP_DB_USER || 'root';
const DB_PASSWORD = process.env.WP_DB_PASSWORD || '';
const DB_NAME = process.env.WP_TEST_DB || 'wonderpress_it_test';

async function dropDb() {
	const admin = await mysql2.createConnection({ host: DB_HOST, user: DB_USER, password: DB_PASSWORD });
	await admin.query('DROP DATABASE IF EXISTS `' + DB_NAME + '`');
	await admin.end();
}

test('init headless: configureWordPress + installWordPress against MySQL', { skip: !RUN }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-it-'));
	const cwd = process.cwd();
	await dropDb();
	try {
		process.chdir(dir);
		fs.writeFileSync('.wonderpressrc', '{}');
		execSync('wp core download --skip-content --force', { stdio: 'inherit' });

		const config = {
			interactive: false,
			db: { host: DB_HOST, user: DB_USER, password: DB_PASSWORD, name: DB_NAME },
			wp: { url: 'example.test', title: 'IT Test', adminUser: 'admin', adminPassword: 'pw', adminEmail: 'admin@example.com' },
		};

		const configured = await wordpress.configureWordPress(config);
		assert.equal(configured, true, 'configureWordPress should succeed');

		await wordpress.installWordPress(config);

		// Throws if WordPress is not installed.
		execSync('wp core is-installed');
	} finally {
		process.chdir(cwd);
		await dropDb();
		fs.removeSync(dir);
	}
});
