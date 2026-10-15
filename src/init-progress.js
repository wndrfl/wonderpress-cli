import * as format from './format.js';
import * as log from './log.js';
import * as proc from './proc.js';

/**
 * `init`'s progress protocol (ARCHITECTURE.md, "App-facing commands and the
 * version pin").
 *
 * Under `init --yes --format json`, stdout is newline-delimited JSON: one
 * `{"event":"step",...}` line each time a step starts and ends, then exactly
 * one final envelope. Every human line init prints goes to stderr instead, as
 * the console tail. In human mode a reporter prints nothing of its own: the
 * phases' log lines are the output, exactly as before.
 *
 * Five steps, in this order, matching the desktop app's build screen. Preflight
 * is deliberately not one: the app has already run `doctor`, and a failed
 * preflight is the envelope's error (code `preflight`) with no step events.
 **/
export const STEPS = [
	{ id: 'scaffold', label: 'Clone the environment scaffold' },
	{ id: 'assets', label: 'Install Static Kit' },
	{ id: 'wordpress', label: 'Install WordPress' },
	{ id: 'core', label: 'Install wonderpress-core' },
	{ id: 'theme', label: 'Activate the theme' },
];

const SIGNALS = ['SIGINT', 'SIGTERM'];
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

/**
 * The error a step reports when the run was stopped by a signal.
 **/
export function cancelledError(signal) {
	return {
		code: 'cancelled',
		message: `init was cancelled (${signal}).`,
		hint: 'The folder was left as it is. Run init again to carry on from where it stopped.',
	};
}

/**
 * Normalise what a step function returned into { ok, error }.
 *
 * A step returns true/undefined (done), false (failed, with the last error
 * the phase logged as its message), or { ok: false, error } to say exactly
 * what went wrong.
 **/
function outcome(result, fallback) {
	if (result === undefined || result === true || (result && result.ok !== false && typeof result === 'object')) {
		return { ok: true, error: null };
	}
	if (result && typeof result === 'object' && result.error) {
		return { ok: false, error: { hint: null, ...result.error } };
	}
	return { ok: false, error: fallback };
}

/**
 * A step reporter for one init run.
 *
 * @param {{ json?: boolean, write?: (line: string) => void, exit?: (code: number) => void }} [opts]
 *   `write` and `exit` are injectable for tests; by default events go to
 *   stdout and a cancel exits the process once the envelope is flushed.
 **/
export function createReporter(opts = {}) {

	const json = opts.json ?? format.isJson();
	// console.log, like format.ok(), except for the cancel envelope, which has
	// to be on the pipe before the process exits.
	const write = opts.write || ((line, cb) => (cb ? process.stdout.write(`${line}\n`, cb) : console.log(line)));
	const exit = opts.exit || ((code) => process.exit(code));

	const states = new Map(STEPS.map((step) => [step.id, { id: step.id, state: 'queued', ms: 0 }]));
	let current = null;
	let finished = false;
	let cancel = null;
	let signalHandlers = [];
	let dataFor = () => ({});

	const emit = (event, cb) => {
		if (json) {
			write(JSON.stringify(event), cb);
		} else if (cb) {
			cb();
		}
	};

	const steps = () => STEPS.map((step) => ({ ...states.get(step.id) }));

	const reporter = {

		json,

		/**
		 * How to describe the project in the final envelope: a function so it is
		 * read at the moment the envelope is printed, after the steps ran.
		 **/
		describe(fn) {
			dataFor = fn;
		},

		/**
		 * Stop on SIGINT/SIGTERM: stop the running child (src/proc.js), mark the
		 * current step failed with code `cancelled`, print the envelope, exit
		 * non-zero. Nothing is deleted. JSON mode only: a human's Ctrl-C keeps
		 * the default behavior it has always had.
		 **/
		trapSignals() {
			if (!json) {
				return;
			}
			proc.setCancellable(true);
			let fire;
			cancel = new Promise((resolve) => { fire = resolve; });
			signalHandlers = SIGNALS.map((signal) => {
				const handler = () => {
					proc.cancelAll(signal);
					fire(signal);
				};
				process.on(signal, handler);
				return [signal, handler];
			});
		},

		releaseSignals() {
			for (const [signal, handler] of signalHandlers) {
				process.removeListener(signal, handler);
			}
			signalHandlers = [];
			if (json) {
				proc.setCancellable(false);
			}
		},

		/**
		 * Run one step. Resolves true when it is done, false when it failed or
		 * the run was cancelled (in which case the envelope has been printed).
		 **/
		async step(id, fn) {
			if (proc.cancelled()) {
				await reporter.cancelled(proc.cancelled());
				return false;
			}
			const def = STEPS.find((step) => step.id === id);
			const record = states.get(id);
			const started = Date.now();
			current = id;
			record.state = 'running';
			emit({ event: 'step', id, label: def.label, state: 'running' });

			// The last error the phase logged, so a step that fails by returning
			// false still says why, in the words it already printed.
			let lastError = null;
			const stopListening = log.onError((message) => { lastError = message; });

			let result;
			let signal = null;
			try {
				const running = Promise.resolve().then(fn);
				if (cancel) {
					const winner = await Promise.race([
						running.then((value) => ({ value })),
						cancel.then((sig) => ({ signal: sig })),
					]);
					signal = winner.signal || null;
					result = winner.value;
				} else {
					result = await running;
				}
			} catch (e) {
				result = { ok: false, error: { code: id, message: e && e.message ? e.message : String(e) } };
			} finally {
				stopListening();
			}

			record.ms = Date.now() - started;

			if (signal || proc.cancelled()) {
				await reporter.cancelled(signal || proc.cancelled());
				return false;
			}

			const { ok, error } = outcome(result, {
				code: id,
				message: lastError || `The ${id} step failed.`,
				hint: null,
			});

			if (ok) {
				record.state = 'done';
				emit({ event: 'step', id, state: 'done' });
				current = null;
				return true;
			}

			record.state = 'failed';
			record.error = error;
			emit({ event: 'step', id, state: 'failed', error: format.envelope(false, null, error).error });
			current = null;
			reporter.finish(false, error);
			return false;
		},

		/**
		 * The run was stopped by a signal: fail the step it stopped in, print
		 * the envelope, and exit once stdout has it.
		 **/
		cancelled(signal) {
			if (finished) {
				return Promise.resolve();
			}
			const error = cancelledError(signal);
			if (current) {
				const record = states.get(current);
				record.state = 'failed';
				emit({ event: 'step', id: current, state: 'failed', error });
			}
			finished = true;
			reporter.releaseSignals();
			log.error(error.message);
			process.exitCode = SIGNAL_EXIT[signal] || format.EXIT_FAIL;
			// Exit from the write callback so the envelope is flushed to the
			// pipe first. The step that was interrupted may still be waiting on
			// a timer or a child that is being stopped; it does not get to run on.
			const envelope = format.envelope(false, { ...dataFor(), steps: steps() }, error);
			return new Promise((resolve) => {
				emit(envelope, () => {
					exit(process.exitCode);
					resolve();
				});
			});
		},

		/**
		 * Print the final envelope (JSON mode). Idempotent: the first call wins.
		 **/
		finish(ok, error = null) {
			if (finished) {
				return ok;
			}
			finished = true;
			reporter.releaseSignals();
			if (!ok && !process.exitCode) {
				process.exitCode = error && error.code === 'usage' ? format.EXIT_USAGE : format.EXIT_FAIL;
			}
			emit(format.envelope(ok, { ...dataFor(), steps: steps() }, ok ? null : error));
			return ok;
		},

		isFinished() {
			return finished;
		},

		steps,
	};

	return reporter;
}
