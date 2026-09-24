import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	ACF_FREE_URL,
	ACF_PRO_URL,
	downloadUrl,
	installAcf,
} from '../src/acf.js';

function root() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-acf-'));
}

function response({ ok = true, status = 200, bytes = [0x50, 0x4b, 0x03, 0x04] } = {}) {
	return {
		ok,
		status,
		async arrayBuffer() {
			return Uint8Array.from(bytes).buffer;
		},
	};
}

function backend(onCall) {
	const calls = [];
	return {
		calls,
		wpCli(args, opts) {
			calls.push({ args, opts });
			return onCall ? onCall(args, opts) : { code: 1, stdout: '', stderr: '' };
		},
	};
}

test('downloadUrl uses the official sources and encodes the PRO key', () => {
	assert.equal(downloadUrl('free'), ACF_FREE_URL);
	assert.equal(
		downloadUrl('pro', 'key with /?&'),
		`${ACF_PRO_URL}&k=key%20with%20%2F%3F%26`,
	);
});

test('ACF PRO requires an environment license before downloading', async () => {
	const fake = backend();
	const result = await installAcf({ edition: 'pro', licenseKey: '', backend: fake });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'missing_license');
	assert.deepEqual(fake.calls.map(({ args }) => args), [
		['plugin', 'is-installed', 'advanced-custom-fields-pro'],
	]);
});

test('downloads PRO itself and gives WP-CLI only a temporary local zip', async () => {
	const dir = root();
	const key = 'secret-license-key';
	let requestedUrl;
	try {
		const fake = backend((args) => {
			if (args[0] === 'plugin' && args[1] === 'install') {
				assert.match(args[2], /^\.wonderpress-tmp\/acf-pro-\d+\.zip$/);
				assert.equal(fs.existsSync(path.join(dir, args[2])), true, 'zip exists while WP-CLI installs it');
				return { code: 0, stdout: '', stderr: '' };
			}
			return { code: 1, stdout: '', stderr: '' };
		});
		const result = await installAcf({
			edition: 'pro',
			licenseKey: key,
			backend: fake,
			root: dir,
			fetchImpl: async (url) => {
				requestedUrl = url;
				return response();
			},
		});

		assert.equal(result.ok, true);
		assert.equal(result.source, 'download');
		assert.equal(requestedUrl, `${ACF_PRO_URL}&k=${key}`);
		assert.equal(fake.calls.some(({ args }) => args.join(' ').includes(key)), false, 'license never enters WP-CLI argv');
		assert.equal(fs.existsSync(path.join(dir, '.wonderpress-tmp')), false, 'temporary download is removed');
	} finally {
		fs.removeSync(dir);
	}
});

test('free edition also comes from ACF, not the WordPress.org slug', async () => {
	const dir = root();
	let requestedUrl;
	try {
		const fake = backend((args) => (
			args[1] === 'install'
				? { code: 0, stdout: '', stderr: '' }
				: { code: 1, stdout: '', stderr: '' }
		));
		const result = await installAcf({
			edition: 'free',
			backend: fake,
			root: dir,
			fetchImpl: async (url) => {
				requestedUrl = url;
				return response();
			},
		});
		assert.equal(result.ok, true);
		assert.equal(requestedUrl, ACF_FREE_URL);
		const install = fake.calls.find(({ args }) => args[1] === 'install');
		assert.match(install.args[2], /^\.wonderpress-tmp\/acf-free-\d+\.zip$/);
	} finally {
		fs.removeSync(dir);
	}
});

test('an installed edition is activated without downloading unless forced', async () => {
	let fetched = false;
	const fake = backend((args) => {
		if (args[1] === 'is-installed') return { code: 0, stdout: '', stderr: '' };
		if (args[1] === 'activate') return { code: 0, stdout: '', stderr: '' };
		return { code: 1, stdout: '', stderr: '' };
	});
	const result = await installAcf({
		edition: 'free',
		backend: fake,
		fetchImpl: async () => {
			fetched = true;
			return response();
		},
	});
	assert.equal(result.ok, true);
	assert.equal(result.source, 'existing');
	assert.equal(fetched, false);
	assert.deepEqual(fake.calls.map(({ args }) => args.slice(0, 2)), [
		['plugin', 'is-installed'],
		['plugin', 'activate'],
	]);
});

test('an installed PRO edition can be activated without supplying its download key again', async () => {
	const fake = backend((args) => ({
		code: ['is-installed', 'activate'].includes(args[1]) ? 0 : 1,
		stdout: '',
		stderr: '',
	}));
	const result = await installAcf({
		edition: 'pro',
		licenseKey: '',
		backend: fake,
	});
	assert.equal(result.ok, true);
	assert.equal(result.source, 'existing');
});

test('refuses to install both editions beside each other', async () => {
	const fake = backend((args) => ({
		code: args[2] === 'advanced-custom-fields' ? 0 : 1,
		stdout: '',
		stderr: '',
	}));
	const result = await installAcf({
		edition: 'pro',
		licenseKey: 'key',
		backend: fake,
	});
	assert.equal(result.ok, false);
	assert.equal(result.error.code, 'edition_conflict');
});

test('rejects an HTML error page even when the download returns HTTP 200', async () => {
	const dir = root();
	try {
		const result = await installAcf({
			edition: 'free',
			backend: backend(),
			root: dir,
			fetchImpl: async () => response({ bytes: [0x3c, 0x68, 0x74, 0x6d, 0x6c] }),
		});
		assert.equal(result.ok, false);
		assert.equal(result.error.code, 'download');
		assert.match(result.error.message, /valid zip/);
		assert.equal(fs.existsSync(path.join(dir, '.wonderpress-tmp')), false);
	} finally {
		fs.removeSync(dir);
	}
});
