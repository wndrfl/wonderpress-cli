import path from 'path';
import pc from 'picocolors';
import * as format from './format.js';

/**
 * How the CLI speaks.
 *
 * Every line used to open with `Wonderpress SUCCESS:` — twelve characters of
 * brand and a syslog level, repeated down the screen, telling the reader the one
 * thing they already knew (they typed `wonderpress`) before telling them
 * anything they did not. Six lines of `agents write` shared fifty-two identical
 * leading characters, and the part that differed — which file — sat at the far
 * right where the eye arrives last.
 *
 * So: no brand, no level word. A glyph in a fixed gutter carries severity, and
 * the message starts at the same column on every line so a run of them reads as
 * a column rather than a paragraph. Everything that is chrome — the directory
 * half of a path, a trailing `--flag` hint — is dimmed, which leaves the bright
 * text meaning "this is the part you are looking for".
 *
 * Nothing here paints the message body. Forcing white (which the old theme did)
 * fights light terminal themes and, worse, spends the contrast budget that the
 * dim/default distinction above needs in order to read as hierarchy.
 **/

const LEVELS = {
	success: { glyph: '✓', paint: pc.green },
	info: { glyph: '·', paint: pc.dim },
	warn: { glyph: '!', paint: pc.yellow },
	error: { glyph: '✕', paint: pc.red },
};

/**
 * Consoles that would render the glyphs as mojibake get letters instead. A `v`
 * is plain; a `â"œ` is damage.
 **/
const ASCII = { '✓': 'v', '·': '-', '!': '!', '✕': 'x' };

const UNICODE = /UTF-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '')
	|| process.platform !== 'win32'
	|| !!process.env.WT_SESSION;

const glyph = (name) => (UNICODE ? LEVELS[name].glyph : ASCII[LEVELS[name].glyph]);

/** Two spaces, one glyph, one space: the message column is always 4. */
const INDENT = '  ';
const CONTINUATION = '    ';

/**
 * A path, shortened to where the reader is standing.
 *
 * Anything that resolves outside the working directory is left absolute, because
 * `../../../var/folders/T/x` is not an improvement on the path it replaced.
 **/
function shorten(abs) {
	const rel = path.relative(process.cwd(), abs);
	return !rel || rel.startsWith('..') ? abs : rel;
}

/** Dim the directory half, so the filename is what the eye lands on. */
function stem(rel) {
	const dir = path.dirname(rel);
	return dir === '.' ? rel : pc.dim(`${dir}/`) + path.basename(rel);
}

/**
 * Absolute paths found in prose.
 *
 * The lookbehind is what keeps URLs intact: in `https://getcomposer.org/download`
 * the only candidate is preceded by a slash, and in `localhost:8080/wp-admin/x`
 * by a digit.
 **/
function paths(msg) {
	return msg.replace(/(?<![:\w/])(?:\/[\w.@~+-]+){2,}/g, (abs) => {
		const rel = shorten(abs);
		return rel === abs ? abs : stem(rel);
	});
}

/**
 * A trailing `(--force to rewrite)` is a footnote, not the sentence. Dimmed and
 * unparenthesised: the brackets were only there to signal "aside", and dimness
 * says that already.
 **/
function aside(msg) {
	return msg.replace(/\s*\(([^()]*--[^()]*)\)\.?\s*$/, (_, hint) => pc.dim(`  ${hint}`));
}

/** Put a body in the gutter. */
function line(level, body) {
	const [first, ...rest] = body.split('\n');
	const head = `${INDENT}${LEVELS[level].paint(glyph(level))} ${first}`;

	// A wrapped message hangs under the message column rather than restarting at
	// the gutter, so the glyph stays the only thing in its lane.
	return [head, ...rest.map((l) => `${CONTINUATION}${l}`)].join('\n');
}

function compose(level, msg) {
	return line(level, aside(paths(String(msg ?? ''))));
}

function write(line) {
	if (format.isJson()) {
		return;
	}
	if (format.isMcp()) {
		process.stderr.write(`${line}\n`);
		return;
	}
	console.log(line);
}

export function error(msg) {
	write(compose('error', msg));
}

export function info(msg) {
	write(compose('info', msg));
}

export function success(msg) {
	write(compose('success', msg));
}

export function warn(msg) {
	write(compose('warn', msg));
}

/**
 * A set of lines that belong to one operation.
 *
 * `agents write` reports six files at once, and reporting them one call at a
 * time leaves their hints ragged — each call sees a single line and cannot know
 * how wide the widest path is. Handing the whole set over buys one aligned
 * column, which is the difference between a list and a table.
 *
 * @param {Array<{ level: keyof LEVELS, path: string, hint?: string }>} rows
 **/
export function group(rows) {
	const entries = rows.filter(Boolean).map((row) => ({ ...row, display: shorten(String(row.path ?? '')) }));

	// Only the hinted lines need a column; padding the others would add trailing
	// whitespace nobody can see and every diff would notice.
	const width = Math.max(0, ...entries.filter((row) => row.hint).map((row) => row.display.length));

	for (const row of entries) {
		const body = row.hint
			? `${stem(row.display.padEnd(width))}  ${pc.dim(row.hint)}`
			: stem(row.display);
		write(line(row.level, body));
	}
}

/**
 * Prose printed as-is: help screens, tables. No gutter, no path rewriting —
 * callers that reach for this have already decided how their output looks.
 **/
export function raw(msg) {
	write(String(msg ?? ''));
}

/**
 * Wizard prose.
 *
 * Wrapped here rather than left to the terminal, which breaks at whatever column
 * the window happens to be and gives a different ragged shape every run. Dim
 * because this is orientation around the question that follows, not the question.
 **/
export function instructions(msg) {
	const max = Math.min((process.stdout.columns || 80) - 4, 78);
	const lines = [];
	let current = '';

	for (const word of String(msg ?? '').split(/\s+/).filter(Boolean)) {
		if (current && `${current} ${word}`.length > max) {
			lines.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) {
		lines.push(current);
	}

	write('');
	for (const line of lines) {
		write(pc.dim(`${INDENT}${line}`));
	}
	write('');
}

/**
 * A block of label/value lines: the "what do I open?" card.
 *
 * No gutter glyph, because these lines are an address rather than an event —
 * severity has nothing to say about a URL. Labels share one column so the
 * values line up, and the blank lines above and below are what separate the
 * card from the run of log lines it lands after.
 *
 * Shared by `init` and `server` so the two places that answer the same question
 * cannot drift into two different shapes.
 *
 * @param {Array<[string, string]>} rows Label/value pairs.
 **/
export function card(rows) {
	const entries = rows.filter(Boolean);
	const width = Math.max(0, ...entries.map(([label]) => String(label).length));

	write('');
	for (const [label, value] of entries) {
		raw(`${INDENT}${String(label).padEnd(width + 2)}${value}`);
	}
	write('');
}

/**
 * Print a simple left-aligned table of strings (a header row + data rows).
 * Used by the `list` commands so their output stays scannable.
 **/
export function table(headers, rows) {
	if (format.quietStdout()) {
		return;
	}
	const widths = headers.map((header, i) => Math.max(String(header).length, ...rows.map((row) => String(row[i] ?? '').length)));
	const line = (cells) => INDENT + cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

	raw(pc.dim(line(headers)));
	for (const row of rows) {
		raw(line(row));
	}
}
