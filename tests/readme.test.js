import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { paramsFromFlags, paramsFromJson, writeReadme } from '../src/readme.js';

test('paramsFromFlags maps fields and applies defaults', () => {
	const p = paramsFromFlags({ '--project-name': 'My Project', '--github-url': 'https://github.com/x/y' });
	assert.equal(p.project_name, 'My Project');
	assert.equal(p.has_github, true);
	assert.equal(p.github_url, 'https://github.com/x/y');
	assert.equal(p.production_url, 'TBD');
});

test('paramsFromJson accepts name/description aliases', () => {
	const p = paramsFromJson(JSON.stringify({ name: 'Zed', description: 'Hi' }));
	assert.equal(p.project_name, 'Zed');
	assert.equal(p.project_description, 'Hi');
});

test('writeReadme: URLs unescaped, backticks literal', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-readme-'));
	const cwd = process.cwd();
	process.chdir(dir);
	try {
		writeReadme(paramsFromFlags({
			'--project-name': 'My Project',
			'--github-url': 'https://github.com/x/y',
			'--production-url': 'https://prod.example',
		}));
		const md = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
		assert.match(md, /https:\/\/github\.com\/x\/y/);   // not HTML-escaped
		assert.doesNotMatch(md, /&#x2F;/);
		assert.match(md, /`\$ wonderpress lint`/);          // literal backticks
	} finally {
		process.chdir(cwd);
		fs.removeSync(dir);
	}
});
