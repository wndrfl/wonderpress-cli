import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import {
	buildDefaultTemplateManifest,
} from '../src/validate.js';
import {
	findPageTemplateManifest,
	listPageTemplates,
	normalizePageTemplateKey,
	removePageTemplate,
	staticTemplateEntryPaths,
} from '../src/template.js';

function tmpTheme() {
	const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-template-')), 'wonderpress');
	fs.ensureDirSync(dir);
	fs.ensureDirSync(path.join(dir, '.wonderpress/manifest/page-templates'));
	fs.ensureDirSync(path.join(dir, 'static/src/js'));
	fs.ensureDirSync(path.join(dir, 'static/src/scss'));
	fs.writeFileSync(path.join(dir, 'static/.staticrc'), JSON.stringify({
		paths: {
			src: { js: 'src/js', scss: 'src/scss', images: 'src/images' },
			dist: { js: 'dist/js', css: 'dist/css', images: 'dist/images' },
		},
	}));
	return dir;
}

function writeLandingManifest(dir) {
	const payload = buildDefaultTemplateManifest('template-landing.php', {
		lock: 'all',
		sections: [{ id: 'hero-main', partial: 'landing-hero' }],
	});
	const manifestPath = path.join(dir, '.wonderpress/manifest/page-templates/template-landing.json');
	fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2));
	fs.writeFileSync(path.join(dir, 'template-landing.php'), '<?php // template');
	fs.writeFileSync(path.join(dir, 'static/src/js/landing.js'), '// js');
	fs.writeFileSync(path.join(dir, 'static/src/scss/landing.scss'), '// scss');
}

test('normalizePageTemplateKey accepts names and filenames', () => {
	assert.equal(normalizePageTemplateKey('Landing'), 'template-landing');
	assert.equal(normalizePageTemplateKey('template-landing.php'), 'template-landing');
	assert.equal(normalizePageTemplateKey('template-landing.json'), 'template-landing');
});

test('listPageTemplates reads manifest index', () => {
	const dir = tmpTheme();
	try {
		writeLandingManifest(dir);
		const rows = listPageTemplates(dir);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].template, 'template-landing.php');
		assert.equal(rows[0].sections, 1);
		assert.equal(rows[0].lock, 'all');
	} finally {
		fs.removeSync(dir);
	}
});

test('findPageTemplateManifest resolves by friendly name', () => {
	const dir = tmpTheme();
	try {
		writeLandingManifest(dir);
		const found = findPageTemplateManifest(dir, 'landing');
		assert.ok(found);
		assert.equal(found.manifest.template, 'template-landing.php');
	} finally {
		fs.removeSync(dir);
	}
});

test('staticTemplateEntryPaths mirror template create static layout', () => {
	const dir = tmpTheme();
	try {
		const paths = staticTemplateEntryPaths(dir, 'template-landing.php');
		assert.deepEqual(paths, ['static/src/js/landing.js', 'static/src/scss/landing.scss']);
	} finally {
		fs.removeSync(dir);
	}
});

test('removePageTemplate deletes PHP, static entries, and manifest', () => {
	const dir = tmpTheme();
	try {
		writeLandingManifest(dir);
		assert.equal(removePageTemplate(dir, 'Landing'), true);
		assert.ok(!fs.existsSync(path.join(dir, 'template-landing.php')));
		assert.ok(!fs.existsSync(path.join(dir, '.wonderpress/manifest/page-templates/template-landing.json')));
		assert.ok(!fs.existsSync(path.join(dir, 'static/src/js/landing.js')));
		assert.ok(!fs.existsSync(path.join(dir, 'static/src/scss/landing.scss')));
	} finally {
		fs.removeSync(dir);
	}
});

test('removePageTemplate --no-static skips static entries', () => {
	const dir = tmpTheme();
	try {
		writeLandingManifest(dir);
		assert.equal(removePageTemplate(dir, 'landing', { noStatic: true }), true);
		assert.ok(!fs.existsSync(path.join(dir, 'template-landing.php')));
		assert.ok(fs.existsSync(path.join(dir, 'static/src/js/landing.js')));
	} finally {
		fs.removeSync(dir);
	}
});
