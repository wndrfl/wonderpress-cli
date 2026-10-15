import fs from 'fs-extra';
import path from 'node:path';

/**
 * A fake command for tests, runnable the way the real one would be on this OS.
 *
 * The behavior is JavaScript (`source`, run by this Node as CommonJS with the
 * real argv in process.argv.slice(2)), so one stub works everywhere. What
 * differs is the launcher: an executable `#!/bin/sh` script on macOS and
 * Linux, and a `.bat` on Windows, which is what Composer and WP-CLI install
 * there and what the CLI resolves on win32.
 *
 * @param {string} dir Directory to write into.
 * @param {string} name Command name, without extension.
 * @param {string} source CommonJS body.
 * @returns {string} The path the CLI would run.
 **/
export function writeStubBin(dir, name, source) {
	fs.ensureDirSync(dir);
	const script = path.join(dir, `${name}.cjs`);
	fs.writeFileSync(script, source);
	if (process.platform === 'win32') {
		const bat = path.join(dir, `${name}.bat`);
		fs.writeFileSync(bat, `@"${process.execPath}" "%~dp0${name}.cjs" %*\r\n@exit /b %ERRORLEVEL%\r\n`);
		return bat;
	}
	const sh = path.join(dir, name);
	fs.writeFileSync(sh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`);
	fs.chmodSync(sh, 0o755);
	return sh;
}

/**
 * phpcs and phpcbf stubs driven by flag files: `failFlag` makes phpcs fail
 * with one fixable error, `warnFlag` makes it pass with five fixable warnings,
 * and phpcbf "fixes" both by deleting the flags and appending to `logFile`.
 **/
export function writePhpcsStubs(binDir, { failFlag, warnFlag, logFile }) {
	writeStubBin(binDir, 'phpcs', `
const fs = require('fs');
const json = process.argv.slice(2).includes('--report=json');
const out = (s) => process.stdout.write(s + '\\n');
if (fs.existsSync(${JSON.stringify(failFlag)})) {
	if (json) out('{"totals":{"errors":1,"warnings":0,"fixable":1},"files":{}}');
	process.exit(1);
}
if (fs.existsSync(${JSON.stringify(warnFlag)})) {
	out(json ? '{"totals":{"errors":0,"warnings":5,"fixable":5},"files":{}}' : 'PHPCBF CAN FIX THE 5 MARKED SNIFF VIOLATIONS AUTOMATICALLY');
	process.exit(0);
}
if (json) out('{"totals":{"errors":0,"warnings":0,"fixable":0},"files":{}}');
process.exit(0);
`);
	writeStubBin(binDir, 'phpcbf', `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(logFile)}, 'ran\\n');
fs.rmSync(${JSON.stringify(failFlag)}, { force: true });
fs.rmSync(${JSON.stringify(warnFlag)}, { force: true });
process.exit(0);
`);
}
