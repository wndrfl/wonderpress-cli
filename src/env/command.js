/**
 * Command construction for environment backends.
 *
 * Pure string work, no I/O — every backend builds its WP-CLI invocations here
 * so the difference between them is one array of leading tokens (`wp` on the
 * host, `<wp-env> run cli wp` in a container) rather than a scattering of
 * hand-concatenated strings.
 **/

// Characters a POSIX shell passes through untouched. Anything outside this set
// gets quoted; anything inside it is emitted verbatim, which is what keeps the
// common case (`wp theme activate wonderpress`) byte-identical to the strings
// this code replaced.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Quote a single argument for a POSIX shell, but only when it needs it.
 **/
export function quoteArg(arg) {

	const str = String(arg);

	// The empty string still needs quotes, or it vanishes from the argv.
	if (str === '') return "''";

	if (SHELL_SAFE.test(str)) return str;

	// Single quotes protect everything except a single quote itself, which has
	// to be closed, escaped, and reopened.
	return `'${str.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build a WP-CLI command line from a backend's leading tokens and a command.
 *
 * `cmd` is the WP-CLI command *without* the leading `wp`. A string is passed
 * through as-is (callers that already hand-built one keep their exact bytes);
 * an array is quoted element by element, which is how a caller opts out of
 * worrying about spaces and shell metacharacters in a value.
 **/
export function buildWpCliCommand(prefix, cmd) {

	const head = (Array.isArray(prefix) ? prefix : [prefix]).map(quoteArg).join(' ');
	const tail = Array.isArray(cmd) ? cmd.map(quoteArg).join(' ') : String(cmd);

	return `${head} ${tail}`.trim();
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
