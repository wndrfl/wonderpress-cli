import sh from 'shelljs';
import * as format from './format.js';
import * as log from './log.js';
import * as composer from './composer.js';
import * as core from './core.js';
import * as wordpress from './wordpress.js';
import * as partial from './partial.js';
import { checkPartialDrift } from './partial-drift.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
	switch (subcommand) {
		case 'theme':
			await theme(args['--dir'] || null, {
				fix: args['--fix'] || false,
				name: args['--name'] || null,
				axe: args['--axe'] || false,
				budget: args['--budget'] || false,
			});
			break;
	}

	return true;
}

/**
 * Resolve which theme directory to lint.
 **/
async function resolveLintTheme(dir, opts) {
	dir = dir || process.cwd();
	process.chdir(dir);

	if (! await core.setCwdToEnvironmentRoot()) {
		return { ok: false, error: { code: 'env', message: 'Not a Wonderpress environment root', hint: 'Run from the project root, or pass --dir.' } };
	}

	if (! await composer.installComposer()) {
		return { ok: false, error: { code: 'composer', message: 'Could not install Composer at the environment root' } };
	}

	let themeName = opts.name ? opts.name : null;

	if (!themeName) {
		const themeInfo = await wordpress.getActiveTheme({ quiet: true });

		if (themeInfo) {
			themeName = themeInfo.name;
		} else {
			const candidates = wordpress.themesOnDisk();

			if (candidates.length === 1) {
				themeName = candidates[0];
				log.info(`Could not ask WordPress which theme is active, so linting the only one present: ${themeName}`);
			} else if (candidates.length === 0) {
				return { ok: false, error: { code: 'theme', message: `No themes found in ${wordpress.pathToThemesDir}.` } };
			} else {
				return {
					ok: false,
					error: {
						code: 'usage',
						message: 'Cannot tell which theme to lint',
						hint: 'wonderpress lint --name <theme>',
					},
					exitCode: format.EXIT_USAGE,
				};
			}
		}
	}

	const themeDir = wordpress.pathToThemesDir + '/' + themeName;
	return { ok: true, themeName, themeDir };
}

/**
 * Structured lint result (phpcs + drift). Used by the CLI and MCP.
 **/
export async function inspectTheme(dir, opts = {}) {
	const resolved = await resolveLintTheme(dir, opts);
	if (!resolved.ok) {
		return resolved;
	}
	const phpcs = runPhpcs(resolved.themeDir, { json: true });
	const drift = collectDrift(resolved.themeDir);
	return {
		ok: phpcs.ok && drift.ok,
		exitCode: phpcs.ok && drift.ok ? format.EXIT_OK : format.EXIT_FAIL,
		data: {
			theme: resolved.themeName,
			phpcs: { ok: phpcs.ok, code: phpcs.code, report: phpcs.report },
			drift,
		},
	};
}

function runPhpcs(themeDir, { json }) {
	let cmd = './vendor/bin/phpcs ' + themeDir + ' -p -v --colors';
	if (json) {
		cmd = './vendor/bin/phpcs ' + themeDir + ' --report=json';
	}
	const lintResult = sh.exec(cmd, { silent: json });
	let report = null;
	if (json && lintResult.stdout) {
		try {
			report = JSON.parse(lintResult.stdout);
		} catch {
			report = { raw: lintResult.stdout };
		}
	}
	return {
		ok: lintResult.code === 0,
		code: lintResult.code,
		report,
	};
}

function collectDrift(themeDir) {
	const manifests = partial.readManifests(themeDir);
	const results = manifests.map((manifest) => checkPartialDrift(manifest, themeDir));
	return {
		ok: results.every((r) => r.ok),
		results,
	};
}

/**
 * Codesniff a specific theme (or the active theme), then check manifest drift.
 **/
export async function theme(dir, opts) {

	log.info('Attempting to lint the active theme...');

	opts = opts || {};
	const resolved = await resolveLintTheme(dir, opts);
	if (!resolved.ok) {
		log.error(resolved.error.message);
		if (resolved.error.hint) {
			log.info(resolved.error.hint);
		}
		return format.fail(resolved.error, resolved.exitCode || format.EXIT_FAIL);
	}

	const { themeName, themeDir } = resolved;
	const wantJson = format.isJson();

	if (opts.axe) {
		log.warn('The axe pass is specified for Phase 3 and is not implemented yet. Skipping.');
	}
	if (opts.budget) {
		log.warn('The Static Kit dist budget is specified for Phase 3 and is not implemented yet. Skipping.');
	}

	const phpcs = runPhpcs(themeDir, { json: wantJson });

	if (phpcs.ok) {
		if (!wantJson) {
			log.success('Great! The theme passed phpcs.');
		}
	} else if (opts.fix) {
		const fixCmd = './vendor/bin/phpcbf ' + themeDir + ' -p -v --colors';
		sh.exec(fixCmd);
		log.info('All issues that could be fixed were fixed. Rerunning phpcs...');
		return theme(process.cwd(), { name: themeName, axe: opts.axe, budget: opts.budget });
	} else if (!wantJson) {
		log.error('Issues were found during phpcs.');
		log.info('If you would like Wonderpress to automatically fix as many issues as possible, add the --fix (or -f) flag to the command.');
	}

	const drift = collectDrift(themeDir);
	if (drift.ok) {
		if (!wantJson) {
			log.success(`Manifest drift: ${drift.results.length} partial${drift.results.length === 1 ? '' : 's'} in sync.`);
		}
	} else if (!wantJson) {
		log.error('Manifest drift detected.');
		for (const result of drift.results.filter((r) => !r.ok)) {
			log.error(`${result.slug}:`);
			for (const issue of result.issues) {
				log.error(`  • ${issue.message}`);
			}
		}
		log.info('Fix with `wonderpress partial sync --all`.');
	}

	const data = {
		theme: themeName,
		phpcs: { ok: phpcs.ok, code: phpcs.code, report: phpcs.report },
		drift,
		axe: opts.axe ? { skipped: true, reason: 'not implemented' } : null,
		budget: opts.budget ? { skipped: true, reason: 'not implemented' } : null,
	};

	const ok = phpcs.ok && drift.ok;
	if (!ok) {
		const code = phpcs.ok ? 'drift' : 'phpcs';
		const message = phpcs.ok
			? 'One or more partials drifted from their manifests'
			: 'phpcs reported issues';
		const hint = phpcs.ok ? 'wonderpress partial sync --all' : 'wonderpress lint --fix';
		return format.fail({ code, message, hint }, format.EXIT_FAIL, data);
	}

	if (wantJson) {
		return format.ok(data);
	}

	log.success('Great! The theme passed all lints.');
	return true;
}
