import fs from 'fs-extra';
import path from 'path';
import * as format from './format.js';
import * as log from './log.js';
import * as composer from './composer.js';
import * as core from './core.js';
import * as wordpress from './wordpress.js';
import * as partial from './partial.js';
import { checkPartialDrift } from './partial-drift.js';
import { checkPageTemplates } from './template-check.js';
import { checkThemeTokenDrift } from './token-drift.js';
import { run } from './proc.js';

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

	const themeDir = path.join(wordpress.pathToThemesDir, themeName);
	return { ok: true, themeName, themeDir };
}

/**
 * The phpcs / phpcbf Composer installs at the environment root.
 *
 * Composer writes a `.bat` proxy beside each vendor binary on Windows, and the
 * extensionless one there is a PHP script nothing can execute directly — so
 * the platform decides which file is the command. Resolved to an absolute
 * path, never `./vendor/bin/...` handed to a shell.
 *
 * @param {'phpcs'|'phpcbf'} tool
 * @param {{ root?: string, platform?: string }} [opts]
 * @returns {string}
 **/
export function phpcsBin(tool, { root = process.cwd(), platform = process.platform } = {}) {
	return path.join(root, 'vendor', 'bin', platform === 'win32' ? `${tool}.bat` : tool);
}

/**
 * A missing binary as a result rather than a shell's "not found": the
 * environment root's Composer install is what provides it.
 **/
function missingTool(bin) {
	const message = `${path.basename(bin)} was not found at ${bin}. Run \`composer install\` at the environment root, then lint again.`;
	return { code: 127, stdout: '', stderr: message, missing: true, toString() { return ''; } };
}

/**
 * Run phpcs or phpcbf with an argv array. `echo` replays the captured output
 * to the terminal (human mode), since the caller also needs to read it.
 **/
function runTool(tool, args, { echo = false } = {}) {
	const bin = phpcsBin(tool);
	if (!fs.existsSync(bin)) {
		const result = missingTool(bin);
		log.error(result.stderr);
		return result;
	}
	const result = run(bin, args, { silent: true });
	if (echo) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
	}
	return result;
}

/**
 * Run phpcbf on a theme directory (CLI `--fix` / MCP `fix: true`).
 **/
export function applyPhpcsFix(themeDir, opts = {}) {
	return runTool('phpcbf', [themeDir, '-p', '-v', '--colors'], { echo: opts.silent !== true });
}

/**
 * True when phpcs found something phpcbf can rewrite.
 * Warnings do not fail the run (`ignore_warnings_on_exit`), so the exit code
 * alone misses auto-fixable alignment and similar sniffs.
 **/
function phpcsHasFixable(phpcs) {
	const reported = phpcs.report && phpcs.report.totals && phpcs.report.totals.fixable;
	if (typeof reported === 'number') {
		return reported > 0;
	}
	const stdout = typeof phpcs.stdout === 'string' ? phpcs.stdout : '';
	const text = stdout.replace(/\u001b\[[0-9;]*m/g, '');
	return /PHPCBF CAN FIX THE \d+ MARKED SNIFF VIOLATIONS AUTOMATICALLY/.test(text);
}

function lintHint({ phpcsOk, driftOk, driftConflict = false, templatesOk, tokensOk = true, wantedFix, didFix }) {
	const parts = [];
	if (!phpcsOk && !wantedFix) {
		parts.push('lint_theme with fix: true (or wonderpress lint --fix)');
	} else if (!phpcsOk && didFix) {
		parts.push('wonderpress lint --fix already ran; remaining phpcs issues need a manual edit');
	}
	if (!driftOk) {
		parts.push('partial_sync with all: true (or wonderpress partial sync --all)');
	}
	if (driftConflict) {
		parts.push('partials in conflict are skipped by sync --all: resolve the hand edits in the IDE, or partial_sync with force: true');
	}
	if (!templatesOk) {
		parts.push('wonderpress template validate');
	}
	if (!tokensOk) {
		parts.push('align theme.json with static/src/scss/lib/tokens/');
	}
	return parts.length ? parts.join('; ') : undefined;
}

/**
 * Structured lint result (phpcs + drift). Used by the CLI and MCP.
 * `opts.fix` runs phpcbf when phpcs failed or reported auto-fixable issues
 * (including warnings, which do not fail the run).
 **/
export async function inspectTheme(dir, opts = {}) {
	const resolved = await resolveLintTheme(dir, opts);
	if (!resolved.ok) {
		return resolved;
	}
	const wantFix = opts.fix === true;
	let phpcs = runPhpcs(resolved.themeDir, { json: true });
	let fixed = false;
	if (wantFix && !phpcs.missing && (!phpcs.ok || phpcsHasFixable(phpcs))) {
		applyPhpcsFix(resolved.themeDir, { silent: true });
		fixed = true;
		phpcs = runPhpcs(resolved.themeDir, { json: true });
	}
	const drift = collectDrift(resolved.themeDir);
	const templates = checkPageTemplates(resolved.themeDir);
	const tokens = checkThemeTokenDrift(resolved.themeDir);
	const ok = phpcs.ok && drift.ok && templates.ok && tokens.ok;
	const data = {
		theme: resolved.themeName,
		phpcs: { ok: phpcs.ok, code: phpcs.code, report: phpcs.report },
		drift,
		templates,
		tokens,
	};
	if (fixed) {
		data.fixed = true;
	}
	const hint = lintHint({
		phpcsOk: phpcs.ok,
		driftOk: drift.ok,
		driftConflict: drift.states.conflict > 0,
		templatesOk: templates.ok,
		tokensOk: tokens.ok,
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
	const args = json ? [themeDir, '--report=json'] : [themeDir, '-p', '-v', '--colors'];
	const lintResult = runTool('phpcs', args, { echo: !json });
	let report = null;
	if (json && lintResult.stdout) {
		try {
			report = JSON.parse(lintResult.stdout);
		} catch {
			report = { raw: lintResult.stdout };
		}
	}
	if (lintResult.missing) {
		report = { error: lintResult.stderr };
	}
	return {
		ok: lintResult.code === 0,
		code: lintResult.code,
		report,
		stdout: lintResult.stdout,
		missing: lintResult.missing === true,
	};
}

/**
 * Partial drift for lint. Severity follows checkPartialDrift's `ok`: a
 * conflict, or generated files that no longer match the manifest, is an error
 * (fails lint, as drift always has); a pending partial whose files still
 * match (no sync lock yet, a reformatted manifest) is a warning. Otherwise
 * upgrading the CLI would fail lint on every lock-less legacy partial.
 **/
function collectDrift(themeDir) {
	const manifests = partial.readManifests(themeDir);
	const results = manifests.map((manifest) => checkPartialDrift(manifest, themeDir));
	const count = (state) => results.filter((r) => r.state === state).length;
	return {
		ok: results.every((r) => r.ok),
		states: { clean: count('clean'), pending: count('pending'), conflict: count('conflict') },
		partials: results.map(partial.driftSummary),
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

	if (opts.fix && !phpcs.missing && (!phpcs.ok || phpcsHasFixable(phpcs))) {
		applyPhpcsFix(themeDir, { silent: format.isJson() });
		log.info('All issues that could be fixed were fixed. Rerunning phpcs...');
		return theme(process.cwd(), { name: themeName, axe: opts.axe, budget: opts.budget });
	}

	if (phpcs.ok) {
		if (!wantJson) {
			log.success('Great! The theme passed phpcs.');
		}
	} else if (phpcs.missing) {
		// runTool already said what is missing and how to install it.
	} else if (!wantJson) {
		log.error('Issues were found during phpcs.');
		log.info('If you would like Wonderpress to automatically fix as many issues as possible, add the --fix (or -f) flag to the command.');
	}

	const drift = collectDrift(themeDir);
	if (!wantJson) {
		// One line per non-clean partial: conflict and out-of-step pending are
		// errors, pending whose files still match is a warning.
		for (const result of drift.results) {
			const line = partial.driftLine(result, result.slug);
			if (line) {
				(result.ok ? log.warn : log.error)(line);
			}
		}
		if (drift.ok) {
			const { clean, pending } = drift.states;
			log.success(`Manifest drift: ${clean} partial${clean === 1 ? '' : 's'} clean${pending ? `, ${pending} pending (warning)` : ''}.`);
		} else {
			log.error(drift.states.conflict
				? 'Manifest drift detected, including hand edits in generated output (conflict).'
				: 'Manifest drift detected.');
			log.info('Fix pending partials with `wonderpress partial sync --all`; resolve conflicts in your IDE, or `wonderpress partial sync <Name> --force`.');
		}
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

	const tokens = checkThemeTokenDrift(themeDir);
	if (tokens.skipped) {
		// No Static Kit token directory. Nothing to compare.
	} else if (tokens.ok) {
		if (!wantJson) {
			log.success('Token drift: theme.json matches Static Kit tokens.');
		}
	} else if (!wantJson) {
		log.error('Token drift detected.');
		for (const issue of tokens.issues) {
			log.error(`  • ${issue.message}`);
		}
		log.info('Align theme.json with static/src/scss/lib/tokens/.');
	}

	const data = {
		theme: themeName,
		phpcs: { ok: phpcs.ok, code: phpcs.code, report: phpcs.report },
		drift,
		templates,
		tokens,
		axe: opts.axe ? { skipped: true, reason: 'not implemented' } : null,
		budget: opts.budget ? { skipped: true, reason: 'not implemented' } : null,
	};

	const ok = phpcs.ok && drift.ok && templates.ok && tokens.ok;
	if (!ok) {
		let code = 'phpcs';
		let message = 'phpcs reported issues';
		if (phpcs.ok && !drift.ok && templates.ok && tokens.ok) {
			code = 'drift';
			message = 'One or more partials drifted from their manifests';
		} else if (phpcs.ok && drift.ok && !templates.ok && tokens.ok) {
			code = 'template';
			message = 'One or more page templates failed validation';
		} else if (phpcs.ok && !drift.ok && !templates.ok && tokens.ok) {
			code = 'drift';
			message = 'Partial drift and page-template checks failed';
		} else if (phpcs.ok && drift.ok && templates.ok && !tokens.ok) {
			code = 'tokens';
			message = 'Static Kit tokens and theme.json are out of sync';
		} else if (phpcs.ok) {
			code = 'tokens';
			message = 'Static Kit tokens and theme.json are out of sync';
		} else if (phpcs.missing) {
			code = 'phpcs-missing';
			message = phpcs.report.error;
		}
		const hint = lintHint({
			phpcsOk: phpcs.ok,
			driftOk: drift.ok,
			driftConflict: drift.states.conflict > 0,
			templatesOk: templates.ok,
			tokensOk: tokens.ok,
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
