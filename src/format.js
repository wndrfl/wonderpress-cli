/**
 * Machine-readable CLI output.
 *
 * Human TTY stays the default. `--format json` prints one envelope on stdout
 * and swallows the colored prose. MCP stdio owns stdout entirely, so logs go
 * to stderr.
 *
 * Anything else that writes to stdout while the protocol owns it (Static Kit's
 * `colors` sequences, a stray console.log) is diverted to stderr. Cursor's
 * JSON-RPC reader will otherwise latch onto the `[` in an ANSI code like
 * `[2m` and die with "Expected ',' or ']' after array element at position 2".
 *
 * Envelope: { ok, data, error: { code, message, hint } | null }
 **/

export const EXIT_OK = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

/** @type {'human' | 'json' | 'mcp'} */
let mode = 'human';

/** @type {typeof process.stdout.write | null} */
let unguardedWrite = null;

/**
 * True when a stdout chunk is JSON-RPC / a JSON envelope, not log chrome.
 *
 * Batches start with `[{`, not `[` — a lone `[` is how ANSI CSI sequences
 * (`[2m`, `[0m`, `[32m`) present once the ESC byte is skipped.
 **/
export function isProtocolChunk(chunk, encoding) {
	let text;
	if (typeof chunk === 'string') {
		text = chunk;
	} else if (Buffer.isBuffer(chunk)) {
		text = chunk.toString(typeof encoding === 'string' ? encoding : 'utf8');
	} else {
		text = String(chunk ?? '');
	}
	const t = text.trimStart();
	return t.startsWith('{') || t.startsWith('[{') || /^Content-Length\s*:/i.test(t);
}

function installStdoutGuard() {
	if (unguardedWrite) {
		return;
	}
	unguardedWrite = process.stdout.write;
	process.stdout.write = function wonderpressStdoutGuard(chunk, encoding, cb) {
		if (!quietStdout() || isProtocolChunk(chunk, encoding)) {
			return unguardedWrite.call(process.stdout, chunk, encoding, cb);
		}
		return process.stderr.write(chunk, encoding, cb);
	};
}

function removeStdoutGuard() {
	if (!unguardedWrite) {
		return;
	}
	process.stdout.write = unguardedWrite;
	unguardedWrite = null;
}

export function reset() {
	mode = 'human';
	removeStdoutGuard();
}

/**
 * @param {Record<string, unknown>} args Parsed CLI args.
 */
export function configure(args = {}) {
	if (args['--format'] === 'json') {
		mode = 'json';
		installStdoutGuard();
	}
}

export function setMcp() {
	mode = 'mcp';
	installStdoutGuard();
}

export function isJson() {
	return mode === 'json';
}

export function isMcp() {
	return mode === 'mcp';
}

/** True when log.* must not write to stdout. */
export function quietStdout() {
	return mode === 'json' || mode === 'mcp';
}

export function envelope(ok, data, error) {
	return {
		ok: !!ok,
		data: data ?? null,
		error: error
			? {
					code: error.code || 'error',
					message: error.message || String(error),
					hint: error.hint ?? null,
				}
			: null,
	};
}

export function ok(data) {
	if (isJson()) {
		console.log(JSON.stringify(envelope(true, data, null)));
	}
	return true;
}

/**
 * @param {{ code: string, message: string, hint?: string|null }} error
 * @param {number} [exitCode]
 * @param {unknown} [data]
 */
export function fail(error, exitCode = EXIT_FAIL, data = null) {
	process.exitCode = exitCode;
	if (isJson()) {
		console.log(JSON.stringify(envelope(false, data, error)));
	}
	return false;
}

/**
 * Parse a JSON envelope out of a CLI stdout dump (last JSON object line).
 *
 * @param {string} stdout
 */
export function parseEnvelope(stdout) {
	const lines = String(stdout || '')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].startsWith('{')) {
			return JSON.parse(lines[i]);
		}
	}
	throw new Error(`No JSON envelope in output:\n${stdout}`);
}
