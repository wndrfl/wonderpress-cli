import colors from 'colors';
import * as format from './format.js';

// Stylize console output
colors.setTheme({
	info: ['white'],
  instructions: ['bold','white'],
  meta: ['magenta'],
	warn: ['bold','yellow'],
	success: ['bold','green'],
	error: ['bold','red']
});

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
	write(`Wonderpress ${'ERROR'.meta}: ${msg.error}`);
}

export function info(msg) {
	write(`Wonderpress ${'INFO'.meta}: ${msg.info}`);
}

export function instructions(msg) {
	write(`Wonderpress ${'INSTRUCTIONS'.instructions}:  ${msg.instructions}`);
}

export function raw(msg) {
  write(`${msg.info}`);
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
	const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

	raw(line(headers));
	for (const row of rows) {
		raw(line(row));
	}
}

export function success(msg) {
	write(`Wonderpress ${'SUCCESS'.meta}: ${msg.success}`);
}

export function warn(msg) {
	write(`Wonderpress ${'WARNING'.warn}: ${msg.warn}`);
}
