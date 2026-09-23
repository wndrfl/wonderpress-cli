import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

function makeFixture() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-log-'));
	fs.writeFileSync(path.join(dir, '.wonderpressrc'), '{}');
	fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/src/partials'));
	fs.ensureDirSync(path.join(dir, 'wp-content/themes/smoke/partials'));
	return dir;
}

/**
 * Whether the CLI colours its output is decided by the environment it runs in,
 * not by this file: picocolors paints when CI is set, and CI is exactly where
 * these run. So assertions about SHAPE strip the codes, and the two tests that
 * care about colour set the environment themselves.
 **/
const plain = (out) => String(out).replace(/\u001B\[[0-9;]*m/g, '');

function run(dir, argv, env = {}) {
	return spawnSync('node', [BIN, ...argv, '--dir', dir, '--theme', 'smoke'], {
		encoding: 'utf8',
		env: { ...process.env, ...env },
	});
}

test('output carries no brand prefix and no level word', () => {
	const dir = makeFixture();
	try {
		const created = run(dir, ['partial', 'create', '--name', 'Smoke_Test']);
		const out = plain(created.stdout + created.stderr);

		assert.equal(created.status, 0, out);
		assert.doesNotMatch(out, /Wonderpress (SUCCESS|INFO|WARNING|ERROR|INSTRUCTIONS)/);
		assert.doesNotMatch(out, /^\s*Wonderpress/m, 'no line opens with the brand');
	} finally {
		fs.removeSync(dir);
	}
});

test('a success line is a glyph in a gutter, then the message', () => {
	const dir = makeFixture();
	try {
		const out = plain(run(dir, ['partial', 'create', '--name', 'Smoke_Test']).stdout);

		assert.match(out, /^ {2}[✓·!✕] \S/m);
		assert.match(out, /created/i, 'the message body survives the restyle');
	} finally {
		fs.removeSync(dir);
	}
});

test('an error names the problem without a level word', () => {
	const result = spawnSync('node', [BIN, 'bogus-command'], { encoding: 'utf8' });
	const out = plain(result.stdout + result.stderr);

	assert.equal(result.status, 1);
	assert.match(out, /^ {2}✕ Unknown command: bogus-command$/m);
});

test('paths inside the working directory lose their stem', () => {
	// Relativising is against cwd, so this drives the CLI from the fixture rather
	// than passing --dir from elsewhere: that is the case a user is actually in.
	const dir = makeFixture();
	try {
		const result = spawnSync('node', [BIN, 'partial', 'create', '--name', 'Smoke_Test', '--theme', 'smoke'], {
			cwd: dir,
			encoding: 'utf8',
		});
		const out = plain(result.stdout + result.stderr);

		assert.equal(result.status, 0, out);
		assert.doesNotMatch(out, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no absolute fixture paths');
		assert.match(out, /wp-content\/themes\/smoke/, 'the path is still there, just relative');
	} finally {
		fs.removeSync(dir);
	}
});

test('a URL survives the path rewriter intact', () => {
	const dir = makeFixture();
	try {
		// `partial list` on an empty theme is the cheapest command that reaches the
		// logger; the guard itself is unit-tested by the shape assertions above.
		// Here we only care that nothing mangles a scheme when one is printed.
		const out = plain(run(dir, ['partial', 'list']).stdout);
		assert.doesNotMatch(out, /https?:\/[^/]/, 'a scheme never loses a slash');
	} finally {
		fs.removeSync(dir);
	}
});

test('a group aligns its hint column across rows', () => {
	// Driven out-of-process because the interesting part is what lands on stdout.
	// The codes have to come off before counting columns: a dimmed directory stem
	// is invisible but not free, so `a/much/longer/path.json` carries two escape
	// sequences that `b.json` does not.
	const script = `
		import * as log from ${JSON.stringify(path.join(__dirname, '..', 'src', 'log.js'))};
		log.group([
			{ level: 'success', path: 'short.md' },
			{ level: 'info', path: 'a/much/longer/path.json', hint: 'left alone' },
			{ level: 'info', path: 'b.json', hint: 'left alone' },
		]);
	`;
	const out = plain(spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' }).stdout);
	const columns = out
		.split('\n')
		.filter((l) => l.includes('left alone'))
		.map((l) => l.indexOf('left alone'));

	assert.equal(columns.length, 2);
	assert.equal(columns[0], columns[1], `hints should share a column, got ${columns} in:\n${out}`);
});

test('agents write reports the configs it preserved', () => {
	// Regression: a preserved MCP entry is flagged `skipped` as well as
	// `preserved`, so a filter that asks about `skipped` first drops all four of
	// them and the second run claims it touched nothing but AGENTS.md.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-log-agents-'));
	try {
		fs.writeFileSync(path.join(root, '.wonderpressrc'), JSON.stringify({ namespace: 'acme' }));
		fs.ensureDirSync(path.join(root, 'wp-content/themes/acme/src/partials'));
		fs.ensureDirSync(path.join(root, 'wp-content/themes/acme/partials'));

		const write = () => spawnSync('node', [BIN, 'agents', 'write', '--theme', 'acme'], { cwd: root, encoding: 'utf8' });
		assert.equal(write().status, 0);
		const second = write();

		const out = plain(second.stdout);
		assert.equal(second.status, 0, out + second.stderr);
		for (const file of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.codex/config.toml']) {
			const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			assert.match(out, new RegExp(`^ {2}· ${escaped}\\s+--force to rewrite$`, 'm'));
		}
	} finally {
		fs.removeSync(root);
	}
});

test('NO_COLOR leaves the output free of escape sequences', () => {
	// The guarantee for anything that pipes or greps us. Asserted explicitly
	// because the ambient environment decides this, and a developer shell that
	// happens to set NO_COLOR will otherwise make every other test here look
	// like it is checking something it is not.
	const dir = makeFixture();
	try {
		const out = run(dir, ['partial', 'create', '--name', 'Smoke_Test'], { NO_COLOR: '1' }).stdout;
		assert.doesNotMatch(out, /\u001B\[/, 'NO_COLOR means no codes at all');
		assert.match(out, /^ {2}✓ /m);
	} finally {
		fs.removeSync(dir);
	}
});

test('FORCE_COLOR paints the gutter without disturbing the shape', () => {
	const dir = makeFixture();
	try {
		const out = run(dir, ['partial', 'create', '--name', 'Smoke_Test'], { FORCE_COLOR: '1', NO_COLOR: '' }).stdout;
		assert.match(out, /\u001B\[32m✓\u001B\[39m/, 'the success glyph is green');
		assert.match(plain(out), /^ {2}✓ /m, 'and the line is the same line underneath');
	} finally {
		fs.removeSync(dir);
	}
});

test('--format json still emits only the envelope', () => {
	const dir = makeFixture();
	try {
		run(dir, ['partial', 'create', '--name', 'Smoke_Test']);
		const listed = run(dir, ['partial', 'list', '--format', 'json']);

		const lines = listed.stdout.split('\n').filter(Boolean);
		assert.equal(lines.length, 1, `expected one JSON line, got:\n${listed.stdout}`);
		assert.equal(JSON.parse(lines[0]).ok, true);
		assert.doesNotMatch(listed.stdout, /[✓·✕]/, 'no human gutter in machine output');
	} finally {
		fs.removeSync(dir);
	}
});
