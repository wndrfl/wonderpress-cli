import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	validateManifestProperty,
	validateManifestProperties,
} from '../src/validate.js';
import {
	readPartialEmbedProperties,
	resolveCoreBundledPartialManifest,
	installCorePartialManifest,
} from '../src/partial-manifests.js';

test('core Link manifest validates and compiles conditionals', () => {
	const coreLinkManifest = resolveCoreBundledPartialManifest(null, 'link');
	assert.ok(coreLinkManifest, 'bundled link.json ships with CLI or monorepo core');
	const manifest = JSON.parse(fs.readFileSync(coreLinkManifest, 'utf8'));
	const errors = [];
	validateManifestProperties(manifest.properties, errors, 'Link manifest');
	assert.equal(errors.length, 0, errors.join('; '));

	const siblingNames = new Set(manifest.properties.map((p) => p.name));
	assert.doesNotThrow(() => validateManifestProperty(manifest.properties[5], { siblingNames }));
});

test('resolveCoreBundledPartialManifest finds bundled link.json', () => {
	const resolved = resolveCoreBundledPartialManifest(null, 'link');
	assert.ok(resolved);
	assert.ok(resolved.endsWith(`${path.sep}manifest${path.sep}partials${path.sep}link.json`));
});

test('readPartialEmbedProperties loads bundled Link properties', () => {
	const props = readPartialEmbedProperties(null, 'link');
	assert.ok(Array.isArray(props));
	assert.ok(props.some((p) => p.name === 'content' && p.type === 'string'));
});

test('installCorePartialManifest copies bundled manifest into theme', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-link-manifest-'));
	const themeDir = path.join(dir, 'theme');
	fs.ensureDirSync(path.join(themeDir, '.wonderpress/manifest/partials'));
	try {
		const dest = installCorePartialManifest(themeDir, 'link');
		assert.ok(dest);
		const written = JSON.parse(fs.readFileSync(dest, 'utf8'));
		assert.equal(written.slug, 'link');
		assert.equal(written.core_primitive, true);
	} finally {
		fs.removeSync(dir);
	}
});
