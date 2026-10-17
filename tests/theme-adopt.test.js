import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pickTheme, countLegacyPartials } from '../src/theme.js';
import { namespaceFromBlocks, resolveNamespace } from '../src/partial.js';

/**
 * `theme adopt`: the one-click the desktop app offers for a site whose theme
 * predates manifests. What is pinned here is the contract the app reads: the
 * directories it creates, that it creates nothing else, and the envelope.
 **/

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

function tmp() {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-theme-adopt-')));
}

/** A project root with .wonderpressrc and the named themes (style.css each). */
function project({ rc = {}, themes = ['wonderpress'] } = {}) {
	const root = tmp();
	fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify(rc, null, 2) + '\n');
	for (const name of themes) {
		fs.ensureDirSync(path.join(root, 'wp-content/themes', name));
		fs.writeFileSync(path.join(root, 'wp-content/themes', name, 'style.css'), `/* Theme Name: ${name} */\n`);
	}
	return root;
}

function themeDir(root, name = 'wonderpress') {
	return path.join(root, 'wp-content/themes', name);
}

function cli(argv, cwd) {
	return spawnSync('node', [BIN, ...argv], { encoding: 'utf8', cwd, env: { ...process.env, WONDERPRESS_ENV: '' } });
}

/** stdout must be exactly one envelope line — the app's whole contract. */
function onlyEnvelope(stdout) {
	const lines = String(stdout).split('\n').filter((l) => l.trim());
	assert.equal(lines.length, 1, `expected exactly one stdout line, got:\n${stdout}`);
	return JSON.parse(lines[0]);
}

/** Every path under a directory, relative and sorted, so "touched nothing else" is checkable. */
function tree(dir) {
	const out = [];
	const walk = (d) => {
		for (const entry of fs.readdirSync(d).sort()) {
			const abs = path.join(d, entry);
			// Forward slashes so the expectation reads the same on Windows.
			out.push(path.relative(dir, abs).split(path.sep).join('/'));
			if (fs.statSync(abs).isDirectory()) walk(abs);
		}
	};
	walk(dir);
	return out;
}

test('a theme without manifests gets the two directories and nothing else', () => {
	const root = project();
	fs.ensureDirSync(path.join(themeDir(root), 'partials/hero'));
	fs.ensureDirSync(path.join(themeDir(root), 'partials/footer'));
	fs.writeFileSync(path.join(themeDir(root), 'partials/loose.php'), '<?php // a file, not a partial directory\n');
	const before = tree(themeDir(root));

	const result = cli(['theme', 'adopt', '--format', 'json'], root);
	assert.equal(result.status, 0, result.stderr);
	const envelope = onlyEnvelope(result.stdout);

	assert.equal(envelope.ok, true);
	assert.equal(envelope.error, null);
	assert.deepEqual(envelope.data, {
		theme: 'wonderpress',
		manifestDir: path.join(themeDir(root), '.wonderpress/manifest'),
		created: true,
		namespace: null,
		namespaceSource: 'none',
		legacyPartials: 2,
	});

	assert.ok(fs.statSync(path.join(themeDir(root), '.wonderpress/manifest/partials')).isDirectory());
	assert.ok(fs.statSync(path.join(themeDir(root), '.wonderpress/manifest/page-templates')).isDirectory());

	const added = tree(themeDir(root)).filter((p) => !before.includes(p));
	assert.deepEqual(added, [
		'.wonderpress',
		'.wonderpress/manifest',
		'.wonderpress/manifest/page-templates',
		'.wonderpress/manifest/partials',
	], 'adopt creates the manifest tree and touches no other theme file');

	// The rc file is left alone when no namespace was asked for.
	assert.deepEqual(fs.readJsonSync(path.join(root, '.wonderpressrc')), {});
});

test('a theme that already has manifests is reported, not recreated', () => {
	const root = project({ rc: { namespace: 'acme' } });
	fs.ensureDirSync(path.join(themeDir(root), '.wonderpress/manifest/partials'));
	fs.ensureDirSync(path.join(themeDir(root), '.wonderpress/manifest/page-templates'));
	fs.writeJsonSync(path.join(themeDir(root), '.wonderpress/manifest/partials/hero.json'), { name: 'Hero', slug: 'hero', block: 'acme/hero' });
	const before = tree(themeDir(root));

	const result = cli(['theme', 'adopt', '--format', 'json'], root);
	assert.equal(result.status, 0, result.stderr);
	const envelope = onlyEnvelope(result.stdout);

	assert.equal(envelope.ok, true);
	assert.equal(envelope.data.created, false);
	assert.equal(envelope.data.namespace, 'acme');
	assert.equal(envelope.data.namespaceSource, 'rc');
	assert.equal(envelope.data.legacyPartials, 0);
	assert.deepEqual(tree(themeDir(root)), before, 'a second adopt changes nothing');
	assert.ok(fs.existsSync(path.join(themeDir(root), '.wonderpress/manifest/partials/hero.json')), 'existing manifests survive');
});

test('adopt is idempotent: the second run reports created: false', () => {
	const root = project();
	assert.equal(onlyEnvelope(cli(['theme', 'adopt', '--format', 'json'], root).stdout).data.created, true);
	assert.equal(onlyEnvelope(cli(['theme', 'adopt', '--format', 'json'], root).stdout).data.created, false);
});

test('--namespace is recorded in .wonderpressrc, preserving the other fields', () => {
	const root = project({ rc: { environment: { backend: 'host' }, cliVersion: '2.18.0' } });

	const result = cli(['theme', 'adopt', '--namespace', 'acme', '--format', 'json'], root);
	assert.equal(result.status, 0, result.stderr);
	const envelope = onlyEnvelope(result.stdout);

	assert.equal(envelope.ok, true);
	assert.equal(envelope.data.namespace, 'acme');
	assert.equal(envelope.data.namespaceSource, 'rc');
	assert.deepEqual(fs.readJsonSync(path.join(root, '.wonderpressrc')), {
		environment: { backend: 'host' },
		cliVersion: '2.18.0',
		namespace: 'acme',
	});

	// What `partial create` would now use agrees with what adopt reported.
	const cwd = process.cwd();
	try {
		process.chdir(root);
		assert.equal(resolveNamespace(themeDir(root)), 'acme');
	} finally {
		process.chdir(cwd);
	}
});

test('an invalid --namespace is refused before anything is created', () => {
	const root = project();
	const result = cli(['theme', 'adopt', '--namespace', 'Acme Inc', '--format', 'json'], root);
	assert.equal(result.status, 2);
	const envelope = onlyEnvelope(result.stdout);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, 'usage');
	assert.equal(fs.existsSync(path.join(themeDir(root), '.wonderpress')), false);
	assert.deepEqual(fs.readJsonSync(path.join(root, '.wonderpressrc')), {});
});

test('without --namespace, a theme whose blocks already carry one reports blocks', () => {
	const root = project();
	fs.ensureDirSync(path.join(themeDir(root), 'blocks/hero'));
	fs.writeJsonSync(path.join(themeDir(root), 'blocks/hero/block.json'), { name: 'acme/hero', title: 'Hero' });

	const envelope = onlyEnvelope(cli(['theme', 'adopt', '--format', 'json'], root).stdout);
	assert.equal(envelope.data.namespace, 'acme');
	assert.equal(envelope.data.namespaceSource, 'blocks');
	assert.deepEqual(fs.readJsonSync(path.join(root, '.wonderpressrc')), {}, 'reported, not recorded');
});

test('no theme on disk is an error that says so', () => {
	const root = project({ themes: [] });
	const result = cli(['theme', 'adopt', '--format', 'json'], root);
	assert.equal(result.status, 1);
	const envelope = onlyEnvelope(result.stdout);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.data, null);
	assert.equal(envelope.error.code, 'no_theme');
});

test('several themes on disk need --theme, and the error lists them', () => {
	const root = project({ themes: ['alpha', 'beta'] });
	const result = cli(['theme', 'adopt', '--format', 'json'], root);
	assert.equal(result.status, 1);
	const envelope = onlyEnvelope(result.stdout);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, 'ambiguous_theme');
	assert.match(envelope.error.hint, /alpha, beta/);

	// Naming one resolves it; naming a missing one is its own error.
	const picked = onlyEnvelope(cli(['theme', 'adopt', '--theme', 'beta', '--format', 'json'], root).stdout);
	assert.equal(picked.ok, true);
	assert.equal(picked.data.theme, 'beta');
	assert.ok(fs.existsSync(path.join(themeDir(root, 'beta'), '.wonderpress/manifest/partials')));
	assert.equal(fs.existsSync(path.join(themeDir(root, 'alpha'), '.wonderpress')), false);

	const missing = onlyEnvelope(cli(['theme', 'adopt', '--theme', 'gamma', '--format', 'json'], root).stdout);
	assert.equal(missing.ok, false);
	assert.equal(missing.error.code, 'theme_not_found');
});

test('outside a project, adopt fails in the envelope', () => {
	const dir = tmp();
	const result = cli(['theme', 'adopt', '--format', 'json'], dir);
	assert.equal(result.status, 1);
	const envelope = onlyEnvelope(result.stdout);
	assert.equal(envelope.ok, false);
	assert.equal(envelope.error.code, 'env');
});

test('human output names what happened in the log style', () => {
	const root = project();
	fs.ensureDirSync(path.join(themeDir(root), 'partials/hero'));
	const first = cli(['theme', 'adopt'], root);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /Created wp-content\/themes\/wonderpress\/\.wonderpress\/manifest/);
	assert.match(first.stdout, /No namespace recorded/);
	assert.match(first.stdout, /1 partial directory under partials\//);

	const again = cli(['theme', 'adopt', '--namespace', 'acme'], root);
	assert.match(again.stdout, /already exists/);
	assert.match(again.stdout, /Recorded namespace `acme`/);
});

test('theme with no subcommand shows the group; an unknown one is an error', () => {
	assert.match(cli(['theme'], tmp()).stdout, /theme adopt/);
	const bogus = cli(['theme', 'bogus'], tmp());
	assert.match(bogus.stdout + bogus.stderr, /Unknown theme subcommand: bogus/);
	assert.equal(bogus.status, 1);
});

// --- the pure pieces ---

test('pickTheme: one theme needs no flag, several do, a missing --theme is named', () => {
	assert.deepEqual(pickTheme({}, ['only']), { name: 'only' });
	assert.equal(pickTheme({}, []).error.code, 'no_theme');
	assert.equal(pickTheme({}, ['a', 'b']).error.code, 'ambiguous_theme');
	assert.deepEqual(pickTheme({ '--theme': 'b' }, ['a', 'b']), { name: 'b' });
	assert.equal(pickTheme({ '--theme': 'c' }, ['a', 'b']).error.code, 'theme_not_found');
});

test('countLegacyPartials counts directories only, and 0 without a partials dir', () => {
	const dir = tmp();
	assert.equal(countLegacyPartials(dir), 0);
	fs.ensureDirSync(path.join(dir, 'partials/one'));
	fs.ensureDirSync(path.join(dir, 'partials/two'));
	fs.writeFileSync(path.join(dir, 'partials/three.php'), '');
	assert.equal(countLegacyPartials(dir), 2);
});

test('namespaceFromBlocks prefers manifests, then block.json, else null', () => {
	const dir = tmp();
	assert.equal(namespaceFromBlocks(dir), null);

	fs.ensureDirSync(path.join(dir, 'blocks/hero'));
	fs.writeJsonSync(path.join(dir, 'blocks/hero/block.json'), { name: 'legacy/hero' });
	assert.equal(namespaceFromBlocks(dir), 'legacy');

	fs.ensureDirSync(path.join(dir, '.wonderpress/manifest/partials'));
	fs.writeJsonSync(path.join(dir, '.wonderpress/manifest/partials/cta.json'), { name: 'Cta', slug: 'cta', block: 'indexed/cta' });
	assert.equal(namespaceFromBlocks(dir), 'indexed');
});
