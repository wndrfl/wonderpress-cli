import colors from 'colors';

// Stylize console output
colors.setTheme({
	info: ['white'],
  instructions: ['bold','white'],
  meta: ['magenta'],
	warn: ['bold','yellow'],
	success: ['bold','green'],
	error: ['bold','red']
});

export function error(msg) {
	console.log(`Wonderpress ${'ERROR'.meta}: ${msg.error}`);
}

export function info(msg) {
	console.log(`Wonderpress ${'INFO'.meta}: ${msg.info}`);
}

export function instructions(msg) {
	console.log(`Wonderpress ${'INSTRUCTIONS'.instructions}:  ${msg.instructions}`);
}

export function raw(msg) {
  console.log(`${msg.info}`);
}

/**
 * Print a simple left-aligned table of strings (a header row + data rows).
 * Used by the `list` commands so their output stays scannable.
 **/
export function table(headers, rows) {
	const widths = headers.map((header, i) => Math.max(String(header).length, ...rows.map((row) => String(row[i] ?? '').length)));
	const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

	raw(line(headers));
	for (const row of rows) {
		raw(line(row));
	}
}

export function success(msg) {
  console.log(`Wonderpress ${'SUCCESS'.meta}: ${msg.success}`);
}

export function warn(msg) {
	console.log(`Wonderpress ${'WARNING'.warn}: ${msg.warn}`);
}
