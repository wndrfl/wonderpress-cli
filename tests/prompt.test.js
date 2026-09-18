import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAsk, pickOne } from '../src/prompt.js';

/**
 * The picker's guards, which matter more than the prompt itself.
 *
 * `block create` and both `remove` commands take an argument from a closed set,
 * so a list beats typing. But a picker that blocks a script or a CI run is
 * worse than the error it replaced, and these pin the cases where it must NOT
 * ask.
 **/

test('--yes means do not ask me things', () => {
	assert.equal(canAsk({ '--yes': true }), false);
});

test('nothing to choose from returns nothing, without prompting', async () => {
	// Reached even with a TTY: there is no question to ask.
	const chosen = await pickOne({
		message: 'Which one?',
		choices: [],
		empty: 'There are none.',
		usage: 'Usage: ...',
		args: {},
	});
	assert.equal(chosen, null);
});

test('a non-interactive run refuses rather than hanging', async () => {
	const chosen = await pickOne({
		message: 'Which one?',
		choices: [{ name: 'Hero', value: 'Hero' }],
		empty: 'There are none.',
		usage: 'Usage: wonderpress block create <Name>.',
		args: { '--yes': true },
	});
	assert.equal(chosen, null, 'a script gets an error, never a prompt it cannot answer');
});
