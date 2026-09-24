import fs from 'fs-extra';
import path from 'node:path';
import * as format from './format.js';

/** Files Static Kit itself reads as proof of an existing installation. */
const STATIC_KIT_CONFIGS = ['.staticrc', '.static', 'statickit.json'];

/**
 * Run a Static Kit call with its stdout sent to stderr.
 *
 * Static Kit logs with `colors` on stdout. On an MCP stdio transport that
 * stream is JSON-RPC; a dim code (`[2m`) is enough to drop the connection.
 **/
export async function withRedirectedStdout(fn) {
	const write = process.stdout.write;
	process.stdout.write = function wonderpressRedirectStdout(chunk, encoding, cb) {
		return process.stderr.write(chunk, encoding, cb);
	};
	try {
		return await fn();
	} finally {
		process.stdout.write = write;
	}
}

/**
 * Lazy-load Static Kit and keep its logger on the same colour contract as us.
 *
 * Static Kit paints with the `colors` package, which does not honour NO_COLOR
 * (it keys off TERM / FORCE_COLOR). A piped `wonderpress` run with NO_COLOR
 * would otherwise leak Static Kit's escape sequences onto stdout. Disable that
 * copy of `colors` when we ourselves are not colouring, and always when stdout
 * is a machine protocol (MCP / `--format json`).
 **/
export async function importStaticKit() {
	const staticCli = await import('@wndrfl/static-kit-cli');
	const mute = format.quietStdout() || (process.env.NO_COLOR && process.env.FORCE_COLOR !== '1');
	if (mute) {
		try {
			const colors = (await import('colors')).default;
			colors.disable();
		} catch {
			// colors is Static Kit's dependency; a stripped install has nothing to mute.
		}
	}
	return staticCli;
}

/**
 * Install Static Kit into `dir` and compile it, even when the theme scaffold
 * has already put files there.
 *
 * `installKit` reads *any* existing target directory as "already installed" and
 * returns before copying the framework, so the scaffold shipping one stylesheet
 * under `static/` costs the theme its entire build — `init` exits 0 with no
 * `dist/`. Hold the seeded files aside, install into a clean directory, put
 * them back, and compile last so they reach `dist/`.
 *
 * Both Static Kit calls chdir without restoring, so pass absolute paths and put
 * the caller's cwd back afterwards.
 **/
export async function installStaticKit(staticCli, dir, opts = {}) {
	const target = path.resolve(dir);
	const cwd = process.cwd();
	const installed = STATIC_KIT_CONFIGS.some((f) => fs.existsSync(path.join(target, f)));
	const seeded = !installed && fs.existsSync(target);
	const held = `${target}-wonderpress-seed`;

	if (seeded) {
		fs.removeSync(held);
		fs.moveSync(target, held);
	}

	try {
		await withRedirectedStdout(() => staticCli.core.installKit(target, { ...opts, compile: false }));
	} finally {
		process.chdir(cwd);
		if (seeded) {
			fs.copySync(held, target, { overwrite: true });
			fs.removeSync(held);
		}
	}

	try {
		await withRedirectedStdout(() => staticCli.compile.all({ dir: target }));
	} finally {
		process.chdir(cwd);
	}
}
