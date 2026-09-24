import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import { resolveThemeDir } from './partial.js';
import { compileStatic, staticKitDir } from './static-kit.js';

/**
 * `wonderpress static` — compile the active theme's Static Kit tree
 * without leaving the environment root.
 **/
export async function command(subcommand, args) {
	if (!subcommand || subcommand === 'help') {
		return help.show('static');
	}

	if (subcommand !== 'compile') {
		log.error(`Unknown static subcommand: ${subcommand}`);
		return format.fail(
			{
				code: 'unknown_command',
				message: `Unknown static subcommand: ${subcommand}`,
				hint: 'Run `wonderpress static help`.',
			},
			format.EXIT_USAGE,
		);
	}

	const watch = args['--watch'] === true;
	if (watch && format.isJson()) {
		log.error('`--watch` cannot be used with `--format json`.');
		return format.fail(
			{
				code: 'usage',
				message: '`--watch` cannot be used with `--format json`',
				hint: 'Drop --format json, or compile once without --watch.',
			},
			format.EXIT_USAGE,
		);
	}

	const themeDir = await resolveThemeDir(args);
	if (!themeDir) {
		return format.fail({
			code: 'theme',
			message: 'Could not resolve the theme directory',
			hint: 'Run from the environment root, or pass --dir / --theme.',
		});
	}

	const dir = staticKitDir(themeDir);
	if (watch) {
		log.info(`Watching Static Kit at ${dir} (Ctrl-C to stop).`);
	} else {
		log.info(`Compiling Static Kit at ${dir}...`);
	}

	const result = await compileStatic(dir, { watch });
	if (!result.ok) {
		log.error(result.error.message);
		if (result.error.hint) {
			log.info(result.error.hint);
		}
		return format.fail(result.error);
	}

	if (watch) {
		return true;
	}

	log.success(`Compiled ${dir}.`);
	return format.isJson() ? format.ok(result.data) : true;
}
