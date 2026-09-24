import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as help from '../src/help.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', 'bin', 'wonderpress.js');

// Every one of these invocations used to print nothing at all and exit 0 — a
// typo and a correct command were indistinguishable. The point of these tests is
// less the wording than the guarantee that no entry point is silent again.

function run(...args) {
	const result = spawnSync('node', [BIN, ...args], { encoding: 'utf8' });
	return { out: (result.stdout || '') + (result.stderr || ''), status: result.status };
}

test('a bare invocation explains the CLI instead of exiting silently', () => {
	const { out, status } = run();
	assert.match(out, /USAGE/);
	assert.match(out, /partial/);
	assert.match(out, /block/);
	assert.equal(status, 0, 'asking for orientation is not an error');
});

test('--help and -h reach the same screen', () => {
	assert.match(run('--help').out, /USAGE/);
	assert.match(run('-h').out, /USAGE/);
});

test('an unknown command says so, shows help, and exits non-zero', () => {
	const { out, status } = run('bogus');
	assert.match(out, /Unknown command: bogus/);
	assert.match(out, /USAGE/, 'the error should be followed by what IS available');
	assert.equal(status, 1, 'a typo must not look like success');
});

test('a command group with no subcommand shows that group', () => {
	assert.match(run('partial').out, /partial create/);
	assert.match(run('block').out, /block create/);
	assert.match(run('static').out, /static compile/);
});

test('an unknown subcommand names it and exits non-zero', () => {
	const { out, status } = run('partial', 'bogus');
	assert.match(out, /Unknown partial subcommand: bogus/);
	assert.equal(status, 1);
});

test('static compile --watch refuses --format json', () => {
	const { out, status } = run('static', 'compile', '--watch', '--format', 'json');
	assert.match(out, /cannot be used with `--format json`/);
	assert.equal(status, 2);
});

test('`<command> help` and `<command> --help` both work', () => {
	assert.match(run('block', 'help').out, /block create/);
	assert.match(run('block', '--help').out, /block create/);
	assert.match(run('help', 'block').out, /block create/);
});

test('block help answers "how do I make a block" with both routes', () => {
	const { out } = run('block', 'help');
	// The question that prompted this help existing: a block is not a standalone
	// thing you create, so both paths to one have to be visible here.
	assert.match(out, /partial create --name \w+ --block/, 'the create-both route');
	assert.match(out, /block create \w+/, 'the retrofit route');
	assert.match(out, /cannot exist without its partial/, 'the constraint that explains why');
});

test('help never mentions a command the CLI does not route', () => {
	// Guards the usual rot: a command is renamed, help still advertises the old
	// name, and the first thing a new user types fails.
	const { out } = run();
	const advertised = out
		.split('\n')
		.map((line) => line.match(/^ {2}(\w[\w-]*)\s{2,}\S/))
		.filter(Boolean)
		.map((match) => match[1]);

	assert.ok(advertised.length >= 6, `expected the main screen to list commands, parsed: ${advertised}`);

	for (const command of advertised) {
		const { out: commandOut } = run(command, '--help');
		assert.doesNotMatch(
			commandOut,
			/Unknown command/,
			`main help advertises "${command}", but the CLI does not route it`
		);
	}
});

// --- the topics are files now, so they can go missing ---
//
// They used to be template literals, where a backtick written naturally in
// prose silently terminated the string and took the whole module down. Files
// cannot do that — but they CAN fail to ship, which the old form could not, so
// the risk moved rather than vanished.

test('every advertised topic has a screen', () => {
	for (const topic of [
		'main', 'partial', 'block', 'init', 'template', 'acf', 'agents', 'mcp',
		'lint', 'server', 'destroy', 'version', 'readme', 'static',
	]) {
		assert.equal(help.has(topic), true, `${topic} should have a help screen`);
	}
});

test('topics may contain backticks, which is the whole point', () => {
	// The case that used to be a SYNTAX ERROR rather than a test failure: prose
	// quoting a command, in a string delimited by the same character.
	const { out } = run('partial', 'help');
	assert.match(out, /`wonderpress block help`/);
	assert.match(out, /\\Wonderpress\\Partials/, 'backslashes in a PHP namespace survive too');
});

test('an unknown topic orients rather than scolding', () => {
	assert.equal(help.has('nonsense'), false);
	const { out, status } = run('help', 'nonsense');
	assert.match(out, /build WordPress themes/, 'falls back to the main screen');
	assert.equal(status, 0);
});

test('a topic name cannot wander out of the help directory', () => {
	assert.equal(help.has('../package'), false);
	assert.equal(help.has('../../etc/passwd'), false);
});
