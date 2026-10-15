import sh from 'shelljs';

/**
 * Point shelljs at a real node binary when it refuses to pick one itself.
 *
 * shelljs's synchronous `exec` runs the command through a child node process,
 * and it finds that node at `config.execPath`. On plain Node that is set to
 * `process.execPath` at load time. When `process.versions.electron` is present
 * shelljs leaves it null (the Electron binary is not a node binary when
 * launched normally), and every synchronous `sh.exec()` then returns
 * undefined: lint, doctor's docker checks, composer and the host backend all
 * break.
 *
 * The desktop app runs this CLI on Electron's own Node with
 * `ELECTRON_RUN_AS_NODE=1`, where `process.execPath` IS a working node, so
 * the right answer is to hand shelljs that path. This module is imported first
 * by `bin/wonderpress.js` and `src/cli.js` so it runs before any command
 * executes anything. Outside Electron shelljs has already set execPath and
 * this is a no-op.
 **/
export function ensureShellExecPath(shell = sh, proc = process) {
	if (!shell.config.execPath || proc.versions?.electron) {
		shell.config.execPath = proc.execPath;
	}
	return shell.config.execPath;
}

ensureShellExecPath();
