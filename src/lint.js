import sh from 'shelljs';
import * as format from './format.js';
import * as log from './log.js';
import * as composer from './composer.js';
import * as core from './core.js';
import * as wordpress from './wordpress.js';
import * as partial from './partial.js';
import { checkPartialDrift } from './partial-drift.js';
import { checkPageTemplates } from './template-check.js';

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
 * Run phpcbf on a theme directory (CLI `--fix` / MCP `fix: true`).
 **/
export function applyPhpcsFix(themeDir, opts = {}) {
	return sh.exec('./vendor/bin/phpcbf ' + themeDir + ' -p -v --colors', {
		silent: opts.silent === true,
	});
}

function lintHint({ phpcsOk, driftOk, templatesOk, wantedFix, didFix }) {
	const parts = [];
	if (!phpcsOk && !wantedFix) {
		parts.push('lint_theme with fix: true (or wonderpress lint --fix)');
	} else if (!phpcsOk && didFix) {
		parts.push('wonderpress lint --fix already ran; remaining phpcs issues need a manual edit');
	}
	if (!driftOk) {
		parts.push('partial_sync with all: true (or wonderpress partial sync --all)');
	}
	if (!templatesOk) {
		parts.push('wonderpress template validate');
	}
	return parts.length ? parts.join('; ') : undefined;
}

/**
 * Structured lint result (phpcs + drift). Used by the CLI and MCP.
 * `opts.fix` runs phpcbf only when phpcs failed (same as the CLI).
 **/
export async function inspectTheme(dir, opts = {}) {
	const resolved = await resolveLintTheme(dir, opts);
	if (!resolved.ok) {
		return resolved;
	}
	const wantFix = opts.fix === true;
	let phpcs = runPhpcs(resolved.themeDir, { json: true });
	let fixed = false;
	if (!phpcs.ok && wantFix) {
		applyPhpcsFix(resolved.themeDir, { silent: true });
		fixed = true;
		phpcs = runPhpcs(resolved.themeDir, { json: true });
	}
	const drift = collectDrift(resolved.themeDir);
	const templates = checkPageTemplates(resolved.themeDir);
	const ok = phpcs.ok && drift.ok && templates.ok;
	const data = {
		theme: resolved.themeName,
		phpcs: { ok: phpcs.ok, code: phpcs.code, report: phpcs.report },
		drift,
		templates,
	};
	if (fixed) {
		data.fixed = true;
	}
	const hint = lintHint({
		phpcsOk: phpcs.ok,
		driftOk: drift.ok,
		templatesOk: templates.ok,
		wantedFix: wantFix,
		didFix: fixed,
	});
	if (hint) {
		data.hint = hint;
	}
	return {
		ok,
		exitCode: ok ? format.EXIT_OK : format.EXIT_FAIL,
		data,
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
		applyPhpcsFix(themeDir, { silent: format.isJson() });
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

	const templates = checkPageTemplates(themeDir);
	if (!templates.results.length) {
		if (!wantJson) {
			log.info('No page templates to check.');
		}
	} else if (templates.ok) {
		if (!wantJson) {
			log.success(`Page templates: ${templates.results.length} valid.`);
		}
	} else if (!wantJson) {
		log.error('Page template check failed.');
		for (const result of templates.results.filter((r) => !r.ok)) {
			log.error(`${result.template}:`);
			for (const issue of result.issues) {
				log.error(`  • ${issue.message}`);
			}
		}
		log.info('Fix the reported manifest or PHP file. Re-run with `wonderpress template validate`.');
	}

	const data = {
		theme: themeName,
		phpcs: { ok: phpcs.ok, code: phpcs.code, report: phpcs.report },
		drift,
		templates,
		axe: opts.axe ? { skipped: true, reason: 'not implemented' } : null,
		budget: opts.budget ? { skipped: true, reason: 'not implemented' } : null,
	};

	const ok = phpcs.ok && drift.ok && templates.ok;
	if (!ok) {
		let code = 'phpcs';
		let message = 'phpcs reported issues';
		if (phpcs.ok && !drift.ok && templates.ok) {
			code = 'drift';
			message = 'One or more partials drifted from their manifests';
		} else if (phpcs.ok && drift.ok && !templates.ok) {
			code = 'template';
			message = 'One or more page templates failed validation';
		} else if (phpcs.ok && !drift.ok && !templates.ok) {
			code = 'drift';
			message = 'Partial drift and page-template checks failed';
		}
		const hint = lintHint({
			phpcsOk: phpcs.ok,
			driftOk: drift.ok,
			templatesOk: templates.ok,
			wantedFix: !!opts.fix,
			didFix: false,
		});
		return format.fail({ code, message, hint }, format.EXIT_FAIL, data);
	}

	if (wantJson) {
		return format.ok(data);
	}

	log.success('Great! The theme passed all lints.');
	return true;
}
