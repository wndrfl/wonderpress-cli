import fs from 'fs-extra';
import path from 'node:path';
import * as core from './core.js';
import * as env from './env/index.js';
import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import * as wordpress from './wordpress.js';

export const ACF_FREE_URL = 'https://www.advancedcustomfields.com/latest/';
export const ACF_PRO_URL = 'https://connect.advancedcustomfields.com/index.php?p=pro&a=download';

const EDITIONS = {
	free: {
		label: 'ACF',
		slug: 'advanced-custom-fields',
		opposite: 'advanced-custom-fields-pro',
	},
	pro: {
		label: 'ACF PRO',
		slug: 'advanced-custom-fields-pro',
		opposite: 'advanced-custom-fields',
	},
};

export function downloadUrl(edition, licenseKey) {
	if (edition === 'free') {
		return ACF_FREE_URL;
	}
	return `${ACF_PRO_URL}&k=${encodeURIComponent(licenseKey)}`;
}

function failure(code, message, hint = null) {
	return { ok: false, error: { code, message, hint } };
}

function cleanDownload(dir, file) {
	fs.removeSync(file);
	try {
		if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
			fs.removeSync(dir);
		}
	} catch {
		// Cleanup is best-effort; it must not turn a successful install into failure.
	}
}

/**
 * Download and activate ACF from the vendor's server.
 *
 * The PRO key never reaches WP-CLI argv: Node downloads the zip, then WP-CLI
 * sees only a local filename. That keeps the key out of process lists and
 * shell output. The temporary path sits under the environment root so wp-env's
 * container can see the same file through its project mount.
 */
export async function installAcf({
	edition = 'pro',
	licenseKey = process.env.ACF_PRO_LICENSE,
	force = false,
	backend = env.getCurrent(),
	fetchImpl = globalThis.fetch,
	root = process.cwd(),
} = {}) {
	const selected = EDITIONS[edition];
	if (!selected) {
		return failure('usage', `Unknown ACF edition "${edition}"`);
	}

	const alreadyInstalled = backend.wpCli(
		['plugin', 'is-installed', selected.slug],
		{ silent: true },
	).code === 0;

	if (alreadyInstalled && !force) {
		const activated = backend.wpCli(
			['plugin', 'activate', selected.slug],
			{ silent: true },
		);
		if (activated.code !== 0) {
			return failure('activate', `${selected.label} is installed but could not be activated.`);
		}
		return { ok: true, edition, slug: selected.slug, source: 'existing' };
	}

	if (edition === 'pro' && !licenseKey) {
		return failure(
			'missing_license',
			'ACF PRO requires ACF_PRO_LICENSE in the environment.',
			'Export ACF_PRO_LICENSE, then rerun the command. The key is never accepted as a CLI argument.',
		);
	}

	const conflict = backend.wpCli(
		['plugin', 'is-installed', selected.opposite],
		{ silent: true },
	).code === 0;
	if (conflict) {
		return failure(
			'edition_conflict',
			`The other ACF edition (${selected.opposite}) is already installed.`,
			'Remove the other edition first; WonderPress will not delete a plugin automatically.',
		);
	}

	const tempDir = path.join(root, '.wonderpress-tmp');
	const zip = path.join(tempDir, `acf-${edition}-${process.pid}.zip`);
	fs.ensureDirSync(tempDir);

	try {
		let response;
		try {
			response = await fetchImpl(downloadUrl(edition, licenseKey), { redirect: 'follow' });
		} catch {
			return failure('download', `${selected.label} could not be downloaded from advancedcustomfields.com.`);
		}
		if (!response.ok) {
			return failure(
				'download',
				`${selected.label} download failed with HTTP ${response.status}.`,
				edition === 'pro' ? 'Check ACF_PRO_LICENSE and the license status.' : null,
			);
		}

		let bytes;
		try {
			bytes = Buffer.from(await response.arrayBuffer());
		} catch {
			return failure('download', `${selected.label} download could not be read.`);
		}
		if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
			return failure(
				'download',
				`${selected.label} did not return a valid zip archive.`,
				edition === 'pro' ? 'Check ACF_PRO_LICENSE and the license status.' : null,
			);
		}
		fs.writeFileSync(zip, bytes);

		const localZip = path.relative(root, zip).split(path.sep).join('/');
		const installArgs = ['plugin', 'install', localZip, '--activate'];
		if (force) {
			installArgs.push('--force');
		}
		const installed = backend.wpCli(installArgs, { silent: true });
		if (installed.code !== 0) {
			return failure('install', `${selected.label} was downloaded but WP-CLI could not install it.`);
		}
		return { ok: true, edition, slug: selected.slug, source: 'download' };
	} finally {
		cleanDownload(tempDir, zip);
	}
}

export async function command(subcommand, args) {
	if (!subcommand || subcommand === 'help') {
		return help.show('acf');
	}
	if (subcommand !== 'install') {
		log.error(`Unknown ACF subcommand: ${subcommand}`);
		return format.fail(
			{ code: 'unknown_command', message: `Unknown ACF subcommand: ${subcommand}`, hint: 'Run `wonderpress acf help`.' },
			format.EXIT_USAGE,
		);
	}

	if (args['--dir']) {
		process.chdir(args['--dir']);
	}
	if (!await core.setCwdToEnvironmentRoot()) {
		return format.fail({ code: 'environment', message: 'Could not find a WonderPress environment.' });
	}
	if (!await wordpress.isInstalled()) {
		log.error('WordPress is not installed in this environment.');
		return format.fail({ code: 'wordpress', message: 'WordPress is not installed in this environment.' });
	}

	const edition = args['--free'] ? 'free' : 'pro';
	log.info(`Installing ${EDITIONS[edition].label} from advancedcustomfields.com...`);
	const result = await installAcf({
		edition,
		force: args['--force'] === true,
		root: process.cwd(),
	});
	if (!result.ok) {
		log.error(result.error.message);
		if (result.error.hint) {
			log.info(result.error.hint);
		}
		return format.fail(result.error, result.error.code === 'missing_license' ? format.EXIT_USAGE : format.EXIT_FAIL);
	}

	log.success(`${EDITIONS[edition].label} is installed and active.`);
	return format.isJson() ? format.ok(result) : true;
}
