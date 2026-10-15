/**
 * Command construction for environment backends.
 *
 * Pure argv work, no I/O — every backend builds its WP-CLI invocations here
 * so the difference between them is one array of leading tokens (`wp` on the
 * host, `<wp-env> run cli wp` in a container) rather than a scattering of
 * hand-concatenated strings.
 *
 * This used to build a POSIX shell string, quoting each argument for sh. That
 * is wrong on Windows, where cmd.exe parses the line instead and treats single
 * quotes as literal characters. The result is now an argv array that is never
 * parsed by any shell (see src/proc.js and ARCHITECTURE.md, "Cross-platform
 * support").
 **/

/**
 * Build a WP-CLI invocation from a backend's leading tokens and a command.
 *
 * `cmd` is the WP-CLI command *without* the leading `wp`. An array is used
 * element by element, untouched — a title with spaces or a password with `$`
 * in it is one argument, whatever the platform. A string is split on
 * whitespace, which is only right for commands with no user values in them;
 * every caller in this codebase passes an array.
 *
 * @param {string|string[]} prefix e.g. ['wp'], or [wpEnvBin, 'run', 'cli', 'wp']
 * @param {string|string[]} cmd
 * @returns {{ file: string, args: string[] }}
 **/
export function buildWpCliArgv(prefix, cmd) {

	const head = (Array.isArray(prefix) ? prefix : [prefix]).map(String);
	const tail = Array.isArray(cmd)
		? cmd.map(String)
		: String(cmd).split(/\s+/).filter(Boolean);
	const [file, ...rest] = head;

	return { file, args: [...rest, ...tail] };
}

/**
 * Normalize a shelljs result into a plain `{ code, stdout, stderr }`.
 *
 * `toString()` deliberately returns stdout. shelljs's own ShellString
 * stringifies that way, and several call sites used to rely on it
 * (`JSON.parse(sh.exec(...))`). Returning a bare object would turn those into
 * `JSON.parse("[object Object]")` — which `getAllThemes()` swallows in a
 * try/catch, so the symptom would be `init` quietly ceasing to activate themes
 * rather than an error. The call sites have been fixed to read `.stdout`; this
 * keeps the trap from reopening.
 **/
export function toResult(result) {

	if (result === null || result === undefined) {
		return { code: 1, stdout: '', stderr: '', toString() { return ''; } };
	}

	const stdout = result.stdout ?? '';
	const stderr = result.stderr ?? '';
	const code = result.code ?? 0;

	return { code, stdout, stderr, toString() { return stdout; } };
}
