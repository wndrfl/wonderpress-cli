/**
 * Pure resolution of `init` configuration from flags + environment + defaults.
 *
 * No prompts, no I/O — unit-testable. The bootstrap functions consume the
 * result; in interactive mode any field left undefined here is filled by a
 * prompt, while --yes (non-interactive) fills every field from env or defaults.
 **/

// Defaults mirror the original inquirer prompt defaults so behavior is unchanged.
const DEFAULTS = {
	dbHost: 'localhost',
	dbUser: 'root',
	dbPassword: '',
	dbName: 'wonderpress',
	url: 'wonderpress.localhost',
	title: 'wonderpress',
	adminUser: 'admin',
	adminPassword: 'supersecure',
	adminEmail: 'example@example.com',
};

/**
 * flag ?? env ?? fallback. Treats null/undefined (and empty-string env) as absent.
 **/
export function resolve(flagVal, envVal, fallback) {
	if (flagVal !== undefined && flagVal !== null) {
		return flagVal;
	}
	if (envVal !== undefined && envVal !== null && envVal !== '') {
		return envVal;
	}
	return fallback;
}

/**
 * Resolve the full init config from parsed args and the environment.
 * In interactive mode unprovided fields resolve to `undefined` (to be
 * prompted). With --yes they resolve to the env value or the default.
 **/
export function resolveInitConfig(args, env) {
	args = args || {};
	env = env || {};

	const interactive = !args['--yes'];

	// flag ?? env ?? (non-interactive: default | interactive: undefined)
	const pick = (flagVal, envVal, def) => {
		const resolved = resolve(flagVal, envVal, undefined);
		if (resolved !== undefined) {
			return resolved;
		}
		return interactive ? undefined : def;
	};

	return {
		interactive,
		cleanSlate: !!args['--clean-slate'],
		yes: !!args['--yes'],
		theme: args['--theme'] || null,
		skipReadme: !!args['--skip-readme'],
		readme: !!args['--readme'],
		db: {
			host: pick(args['--db-host'], env.WP_DB_HOST, DEFAULTS.dbHost),
			user: pick(args['--db-user'], env.WP_DB_USER, DEFAULTS.dbUser),
			password: pick(args['--db-password'], env.WP_DB_PASSWORD, DEFAULTS.dbPassword),
			name: pick(args['--db-name'], env.WP_DB_NAME, DEFAULTS.dbName),
		},
		wp: {
			url: pick(args['--wp-url'], env.WP_URL, DEFAULTS.url),
			title: pick(args['--wp-title'], env.WP_TITLE, DEFAULTS.title),
			adminUser: pick(args['--admin-user'], env.WP_ADMIN_USER, DEFAULTS.adminUser),
			adminPassword: pick(args['--admin-password'], env.WP_ADMIN_PASSWORD, DEFAULTS.adminPassword),
			adminEmail: pick(args['--admin-email'], env.WP_ADMIN_EMAIL, DEFAULTS.adminEmail),
		},
	};
}

export { DEFAULTS };
