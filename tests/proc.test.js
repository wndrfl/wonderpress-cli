import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildSpawn, isBatchFile, portOwnerCommand, quoteForCmd, run, toPosixPath } from '../src/proc.js';
import { writeStubBin } from './helpers/stub-bin.js';

// The argv rule (ARCHITECTURE.md, "Cross-platform support"): commands that
// carry user values are run as argv arrays. These pin the one place Windows
// still needs cmd.exe, and that nothing a user typed is ever reparsed.

test('POSIX and real executables pass through untouched', () => {
	for (const platform of ['darwin', 'linux']) {
		assert.deepEqual(buildSpawn('wp', ['option', 'update', 'blogname', 'My Site'], { platform }), {
			file: 'wp',
			args: ['option', 'update', 'blogname', 'My Site'],
			windowsVerbatimArguments: false,
		});
	}
	assert.deepEqual(buildSpawn('C:\\Program Files\\Git\\cmd\\git.exe', ['clone', 'x y'], { platform: 'win32' }).args, ['clone', 'x y']);
});

test('a batch file on Windows runs through cmd.exe with every argument escaped', () => {
	assert.equal(isBatchFile('C:\\tools\\wp.bat', 'win32'), true);
	assert.equal(isBatchFile('C:\\x\\node_modules\\.bin\\wp-env.CMD', 'win32'), true);
	assert.equal(isBatchFile('/usr/local/bin/wp.bat', 'darwin'), false);

	const spec = buildSpawn('C:\\tools\\wp.bat', ['option', 'update', 'blogname', 'Tom & Jerry 100%'], { platform: 'win32', comspec: 'C:\\Windows\\system32\\cmd.exe' });
	assert.equal(spec.file, 'C:\\Windows\\system32\\cmd.exe');
	assert.equal(spec.windowsVerbatimArguments, true);
	assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
	assert.equal(spec.args[3], '"C:\\tools\\wp.bat ^"option^" ^"update^" ^"blogname^" ^"Tom^ ^&^ Jerry^ 100^%^""');
});

test('quoteForCmd neutralizes quotes, backslashes and metacharacters', () => {
	assert.equal(quoteForCmd('plain'), '^"plain^"');
	assert.equal(quoteForCmd('a"b'), '^"a\\^"b^"');
	assert.equal(quoteForCmd('C:\\dir\\'), '^"C:\\dir\\\\^"');
	assert.equal(quoteForCmd('x|y', true), '^^^"x^^^|y^^^"');
});

test('npm .bin shims get the double escape', () => {
	const spec = buildSpawn('C:\\p\\node_modules\\.bin\\wp-env.cmd', ['run', 'a&b'], { platform: 'win32', comspec: 'cmd.exe' });
	assert.match(spec.args[3], /\^\^\^"a\^\^\^&b\^\^\^"/);
});

test('toPosixPath writes forward slashes whatever the OS', () => {
	assert.equal(toPosixPath('wp-content\\themes\\acme\\partials\\hero.php'), 'wp-content/themes/acme/partials/hero.php');
	assert.equal(toPosixPath('already/posix'), 'already/posix');
});

test('the port-owner hint names the platform\'s own tool', () => {
	assert.match(portOwnerCommand(8888, 'darwin'), /^lsof .*8888/);
	assert.match(portOwnerCommand(8888, 'linux'), /^ss .*8888/);
	assert.match(portOwnerCommand(8888, 'win32'), /Get-NetTCPConnection -LocalPort 8888/);
	assert.match(portOwnerCommand(8888, 'win32'), /netstat/);
	assert.doesNotMatch(portOwnerCommand(8888, 'win32'), /lsof/);
	assert.doesNotMatch(portOwnerCommand(8888, 'linux'), /lsof/);
});

test('run reports a missing program as code 127, not a throw', () => {
	const result = run('wonderpress-no-such-program-xyz', ['--version'], { silent: true });
	assert.equal(result.code, 127);
	assert.match(result.stderr, /wonderpress-no-such-program-xyz/);
	assert.equal(String(result), '');
});

test('run passes hostile arguments through byte for byte, on this OS', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp proc '));
	try {
		const bin = writeStubBin(dir, 'echoargs', `process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exit(3);\n`);
		const args = ['My Site', 'Tom & Jerry', '100%', '$HOME', '"quoted"', 'a|b', 'semi;colon', 'back\\slash\\', '', 'it\'s', '(paren)', '!bang!'];
		const result = run(bin, args, { silent: true });
		assert.equal(result.code, 3);
		assert.deepEqual(JSON.parse(result.stdout), args);
	} finally {
		fs.removeSync(dir);
	}
});

test('run writes input to stdin and honors cwd', () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-proc-')));
	try {
		const bin = writeStubBin(dir, 'readin', `let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({ s, cwd: process.cwd() })));\n`);
		const result = run(bin, [], { input: 'y\n', cwd: dir });
		assert.equal(result.code, 0);
		const body = JSON.parse(result.stdout);
		assert.equal(body.s, 'y\n');
		assert.equal(fs.realpathSync(body.cwd), dir);
	} finally {
		fs.removeSync(dir);
	}
});

test('in --format json, a child\'s output goes to stderr and the envelope owns stdout', () => {
	const src = (file) => JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', 'src', file)).href);
	const script = `
		import * as format from ${src('format.js')};
		import { run } from ${src('proc.js')};
		format.configure({ '--format': 'json' });
		run(process.execPath, ['-e', 'console.log("composer chatter")']);
		process.stdout.write(JSON.stringify({ ok: true, data: null, error: null }) + '\\n');
	`;
	const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, '{"ok":true,"data":null,"error":null}\n');
	assert.match(result.stderr, /composer chatter/);
});
