import { spawnSync } from 'child_process';
import path from 'path';
import sh from 'shelljs';
import { quietStdout } from './format.js';

/**
 * Running other programs, the same way on macOS, Linux and Windows.
 *
 * The rule (ARCHITECTURE.md, "Cross-platform support"): a command that carries
 * a path, a name, a password or anything else a user supplied is run as an
 * argv array, never as a string handed to a shell. A string is parsed by
 * whichever shell happens to be there — sh on macOS and Linux, cmd.exe on
 * Windows — and the two disagree about quoting, `$`, `%`, `&` and spaces.
 * An argv array is not parsed by anything.
 *
 * The one place Windows still needs a shell is a `.cmd` or `.bat` file (npm's
 * shims, `wp.bat`, `composer.bat`): CreateProcess cannot run them, and Node
 * refuses to spawn them without `shell: true` since CVE-2024-27980. For those,
 * run() builds the cmd.exe command line itself, escaping every argument, so
 * the caller still passes argv and never a string.
 **/

// Characters cmd.exe treats specially, escaped with a caret. The same set
// cross-spawn uses, which is what npm itself relies on.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Is this a Windows batch file, which only cmd.exe can run?
 **/
export function isBatchFile(file, platform = process.platform) {
	return platform === 'win32' && /\.(cmd|bat)$/i.test(String(file));
}

/**
 * Quote one argument for a cmd.exe command line that runs a batch file.
 *
 * MSVCRT rules first (backslashes before a quote are doubled, the quote is
 * escaped, the whole thing is wrapped), then every cmd.exe metacharacter is
 * caret-escaped so `&`, `|`, `%` and friends arrive as text. `doubleEscape`
 * escapes twice, for npm's `node_modules/.bin/*.cmd` shims, which pass `%*`
 * through a second round of cmd.exe parsing.
 **/
export function quoteForCmd(arg, doubleEscape = false) {
	let str = String(arg);
	str = str.replace(/(\\*)"/g, '$1$1\\"');
	str = str.replace(/(\\*)$/, '$1$1');
	str = `"${str}"`;
	str = str.replace(CMD_META, '^$1');
	if (doubleEscape) {
		str = str.replace(CMD_META, '^$1');
	}
	return str;
}

/**
 * What to actually hand to spawn for `file args`, on `platform`.
 *
 * Pure, so the Windows branch is testable on any OS. On POSIX, and for real
 * executables on Windows, this is `file` and `args` unchanged. A batch file on
 * Windows becomes `cmd.exe /d /s /c "<escaped line>"` with verbatim arguments,
 * so Node adds no quoting of its own on top.
 *
 * @returns {{ file: string, args: string[], windowsVerbatimArguments: boolean }}
 **/
export function buildSpawn(file, args = [], { platform = process.platform, comspec = process.env.ComSpec } = {}) {
	if (!isBatchFile(file, platform)) {
		return { file, args: args.map(String), windowsVerbatimArguments: false };
	}
	const doubleEscape = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(file);
	const command = path.win32.normalize(file).replace(CMD_META, '^$1');
	const line = [command, ...args.map((arg) => quoteForCmd(arg, doubleEscape))].join(' ');
	return {
		file: comspec || 'cmd.exe',
		args: ['/d', '/s', '/c', `"${line}"`],
		windowsVerbatimArguments: true,
	};
}

/**
 * Where `bin` lives, or `bin` itself.
 *
 * On Windows a bare name is looked up on PATH with PATHEXT (shelljs's which),
 * because spawn will not find `wp.bat` from `wp` on its own, and run() needs
 * the extension to know whether cmd.exe is involved. POSIX spawn searches
 * PATH itself, so the name is left alone there.
 **/
export function resolveBin(bin, platform = process.platform) {
	if (platform !== 'win32' || path.isAbsolute(bin) || /[\\/]/.test(bin)) {
		return bin;
	}
	const found = sh.which(bin);
	return found ? String(found) : bin;
}

/**
 * Run `bin` with an argv array and wait for it.
 *
 * Returns the same `{ code, stdout, stderr }` shape shelljs's exec did, with
 * the same `toString()` → stdout, so call sites that were converted from
 * `sh.exec(string)` read the result unchanged.
 *
 * - `silent: true` captures stdout and stderr. Otherwise both stream to the
 *   terminal as they happen and are not captured — except that while
 *   `--format json` or MCP owns stdout, the child's stdout goes to stderr, so
 *   the envelope stays the only thing on stdout. stdin is never inherited: in
 *   MCP mode it is the protocol channel.
 * - `stdio` overrides both, for callers that need a specific wiring.
 * - `input` is written to stdin.
 *
 * A program that cannot be found is `code: 127` with the reason in stderr,
 * rather than a throw: the callers all branch on `code`.
 **/
export function run(bin, args = [], opts = {}) {
	const platform = opts.platform || process.platform;
	const spec = buildSpawn(resolveBin(bin, platform), args, { platform });
	const stdio = opts.stdio
		|| (opts.input !== undefined
			? ['pipe', 'pipe', 'pipe']
			: (opts.silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', quietStdout() ? 2 : 'inherit', 'inherit']));

	const result = spawnSync(spec.file, spec.args, {
		cwd: opts.cwd || process.cwd(),
		env: opts.env || process.env,
		input: opts.input,
		stdio,
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
		windowsVerbatimArguments: spec.windowsVerbatimArguments,
	});

	if (result.error) {
		const stderr = `${bin}: ${result.error.message}`;
		return { code: result.error.code === 'ENOENT' ? 127 : 1, stdout: '', stderr, toString() { return ''; } };
	}

	const stdout = result.stdout || '';
	const stderr = result.stderr || '';
	const code = result.status ?? 1;
	return { code, stdout, stderr, toString() { return stdout; } };
}

/**
 * A path as it is written INTO a file another machine will read: manifests,
 * lock files, .wonderpressrc. Always forward slashes,
 * whatever OS wrote it (app spec section 3: "manifests always use forward
 * slashes"). Paths used to touch the filesystem stay native; this is only for
 * the boundary where a path becomes data.
 **/
export function toPosixPath(p) {
	return String(p).replace(/\\/g, '/');
}

/**
 * How to see what holds a TCP port, in the platform's own words.
 **/
export function portOwnerCommand(port, platform = process.platform) {
	switch (platform) {
		case 'win32':
			return `Get-NetTCPConnection -LocalPort ${port} -State Listen   (PowerShell; or: netstat -ano | findstr :${port})`;
		case 'linux':
			return `ss -ltnp 'sport = :${port}'`;
		default:
			return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
	}
}
