import { spawn, spawnSync } from 'child_process';
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
 * rather than a throw: the callers all branch on `code`. Unless `silent`, that
 * reason is also printed to stderr, the way the shell used to print
 * `wp: command not found` before these calls were argv spawns — otherwise a
 * missing program fails with no word as to why.
 *
 * A child ended by a signal (Ctrl-C on a foreground server) has `signal` set,
 * so a caller can tell a stop from a failure.
 **/
export function run(bin, args = [], opts = {}) {
	if (cancelledBy) {
		return cancelledResult(bin);
	}
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
		const stderr = `${bin}: ${result.error.code === 'ENOENT' ? 'command not found' : result.error.message}`;
		if (!opts.silent) {
			process.stderr.write(`${stderr}\n`);
		}
		return { code: result.error.code === 'ENOENT' ? 127 : 1, stdout: '', stderr, signal: null, error: result.error, toString() { return ''; } };
	}

	const stdout = result.stdout || '';
	const stderr = result.stderr || '';
	const code = result.status ?? 1;
	return { code, stdout, stderr, signal: result.signal || null, toString() { return stdout; } };
}

/**
 * Cancellation, for `init --format json` (ARCHITECTURE.md, "App-facing
 * commands and the version pin").
 *
 * The desktop app stops a build by signalling `init`. run() blocks the event
 * loop in spawnSync, so a signal is only handled once the child it is waiting
 * on has finished — fine for a two-second WP-CLI call, not for a three-minute
 * `wp-env start`. The long-running children of `init` therefore go through
 * runAsync(), which keeps the event loop free and records the child here so
 * cancelAll() can stop it.
 *
 * While cancellable mode is on (POSIX), each such child leads its own process
 * group, and cancelAll() signals the whole group: `wp-env start` runs
 * `docker compose`, `composer` runs PHP, `npm` runs scripts, and stopping
 * only the leader would leave those running. Windows has no groups; the tree
 * is killed with `taskkill /T`. Outside cancellable mode runAsync() leaves the
 * child in this process's group, so a terminal's Ctrl-C reaches it exactly as
 * it reaches a run() child.
 *
 * Once cancelled, run() and runAsync() start nothing new: they return a
 * failed result at once, so a step that carries on after its child was
 * stopped cannot start the next one.
 **/
const active = new Set();
let cancellable = false;
let cancelledBy = null;

/**
 * Turn process-group cancellation on or off. Resets the cancelled state.
 **/
export function setCancellable(on) {
	cancellable = !!on;
	cancelledBy = null;
}

/**
 * The signal that cancelled this run, or null.
 **/
export function cancelled() {
	return cancelledBy;
}

function cancelledResult(bin) {
	const stderr = `${bin}: not started, the run was cancelled (${cancelledBy})`;
	return { code: 130, stdout: '', stderr, signal: cancelledBy, cancelled: true, toString() { return ''; } };
}

/**
 * Stop every child runAsync() is waiting on, and refuse to start more.
 *
 * @param {string} [signal] The signal to send (and to record as the reason).
 * @param {string} [platform]
 **/
export function cancelAll(signal = 'SIGTERM', platform = process.platform) {
	cancelledBy = cancelledBy || signal;
	for (const child of active) {
		killTree(child, signal, platform);
	}
}

/**
 * Signal a child and everything it started.
 **/
export function killTree(child, signal = 'SIGTERM', platform = process.platform) {
	if (!child || !child.pid) {
		return;
	}
	try {
		if (platform === 'win32') {
			spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
		} else if (child.wonderpressGroup) {
			process.kill(-child.pid, signal);
		} else {
			child.kill(signal);
		}
	} catch (e) {
		// ESRCH: already gone, which is what was wanted.
	}
}

/**
 * run(), without blocking the event loop, and stoppable by cancelAll().
 *
 * Same options and the same `{ code, stdout, stderr, signal }` result as
 * run(), minus `input`. Streams exactly as run() does: captured when
 * `silent`, otherwise live (to stderr while `--format json` owns stdout).
 *
 * @returns {Promise<{ code: number, stdout: string, stderr: string, signal: string|null }>}
 **/
export function runAsync(bin, args = [], opts = {}) {
	if (cancelledBy) {
		return Promise.resolve(cancelledResult(bin));
	}

	const platform = opts.platform || process.platform;
	const spec = buildSpawn(resolveBin(bin, platform), args, { platform });
	const stdio = opts.stdio
		|| (opts.silent ? ['ignore', 'pipe', 'pipe'] : ['ignore', quietStdout() ? 2 : 'inherit', 'inherit']);
	const group = cancellable && platform !== 'win32';

	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(spec.file, spec.args, {
				cwd: opts.cwd || process.cwd(),
				env: opts.env || process.env,
				stdio,
				detached: group,
				windowsHide: true,
				windowsVerbatimArguments: spec.windowsVerbatimArguments,
			});
		} catch (error) {
			resolve(notFound(bin, error, opts));
			return;
		}
		child.wonderpressGroup = group;
		active.add(child);

		let stdout = '';
		let stderr = '';
		if (child.stdout) {
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (chunk) => { stdout += chunk; });
		}
		if (child.stderr) {
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (chunk) => { stderr += chunk; });
		}

		let settled = false;
		const settle = (result) => {
			if (settled) {
				return;
			}
			settled = true;
			active.delete(child);
			resolve(result);
		};

		child.once('error', (error) => settle(notFound(bin, error, opts)));
		child.once('close', (code, signal) => {
			// A group leader that exits can leave the rest of its group behind;
			// after a cancel, sweep it.
			if (cancelledBy && group) {
				killTree(child, 'SIGTERM', platform);
			}
			settle({
				code: code ?? 1,
				stdout,
				stderr,
				signal: signal || null,
				...(cancelledBy ? { cancelled: true } : {}),
				toString() { return stdout; },
			});
		});
	});
}

function notFound(bin, error, opts) {
	const stderr = `${bin}: ${error.code === 'ENOENT' ? 'command not found' : error.message}`;
	if (!opts.silent) {
		process.stderr.write(`${stderr}\n`);
	}
	return { code: error.code === 'ENOENT' ? 127 : 1, stdout: '', stderr, signal: null, error, toString() { return ''; } };
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
