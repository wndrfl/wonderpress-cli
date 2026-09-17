import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import * as log from './log.js';

/**
 * Help text for the CLI.
 *
 * The topics live in `src/help/*.txt` as plain text, NOT as JavaScript strings.
 *
 * They used to be template literals, and twice in two days a backtick written
 * naturally in prose — ``see `wonderpress block help` `` — silently terminated
 * the string and took the whole module out, failing a dozen unrelated tests
 * with a syntax error that named nothing helpful. Help text is prose about
 * commands, so it will always want to quote commands; any JS delimiter has some
 * character that prose eventually contains. Text files have none.
 *
 * Kept as data rather than scattered through the command modules so every topic
 * reads in one voice, and so `help` can list what exists without each module
 * having to announce itself.
 **/

const TOPIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'help');

/**
 * Read a topic off disk, or null if there is no such screen.
 *
 * Deliberately not cached: help is printed once per invocation, and a cache
 * would only exist to save a read that never happens twice.
 **/
function read(topic) {

	// A topic name reaches this from argv, so it is not allowed to wander out of
	// the help directory.
	if (typeof topic !== 'string' || !/^[a-z-]+$/.test(topic)) {
		return null;
	}

	const file = path.join(TOPIC_DIR, `${topic}.txt`);

	return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd() : null;
}

/**
 * Print a help topic. Unknown topics fall back to the main screen rather than
 * erroring — someone typing `help whatever` wants orientation, not a scolding.
 **/
export function show(topic) {
	log.raw(read(topic) || read('main'));
	return true;
}

/**
 * Whether a topic has its own screen.
 **/
export function has(topic) {
	return read(topic) !== null;
}

/**
 * True when the args ask for help — `help` as a command or subcommand, or the
 * --help/-h flag anywhere.
 **/
export function requested(args) {
	return !!args['--help'] || args._.includes('help');
}
