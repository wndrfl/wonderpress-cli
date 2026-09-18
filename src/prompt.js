import inquirer from 'inquirer';
import * as log from './log.js';

/**
 * Asking for a name the CLI could have offered instead.
 *
 * `block create` and the two `remove` commands all take an argument from a
 * CLOSED set — a block can only wrap a partial that exists, and only a partial
 * that exists can be removed. That is exactly the case where a list beats
 * typing: without one, the flow is `partial list`, read a name, then retype
 * `Testimonial_Card` with the right capitalisation and underscores, and a typo
 * gets an error rather than a component.
 *
 * `partial create` with no arguments has always run a wizard; these printed
 * "No name provided. Usage:" and exited. Same gesture, same CLI, one guiding
 * and one scolding.
 **/

/**
 * Is there a human at the other end?
 *
 * A picker that blocks a script or a CI run is worse than the error it
 * replaced, so this is checked before anything is offered. --yes means "do not
 * ask me things", which includes this.
 **/
export function canAsk(args = {}) {
	return !args['--yes'] && !!process.stdin.isTTY;
}

/**
 * Offer a list, or explain why there is nothing to offer.
 *
 * `empty` is not an error message — "every partial is already exposed as a
 * block" is a useful thing to be told, and the caller knows how to phrase its
 * own version of that.
 *
 * Returns the chosen value, or null when nothing could be chosen.
 **/
export async function pickOne({ message, choices, empty, usage, args = {} }) {

	if (!choices.length) {
		log.info(empty);
		return null;
	}

	if (!canAsk(args)) {
		// Non-interactive: name it explicitly. Listing the candidates is the
		// useful half of what the picker would have done.
		log.error(`No name provided. ${usage}`);
		log.info(`Available: ${choices.map((choice) => choice.value).join(', ')}`);
		return null;
	}

	const answer = await inquirer.prompt([
		{
			type: 'list',
			name: 'choice',
			message,
			choices,
			loop: false,
		},
	]);

	return answer.choice;
}
