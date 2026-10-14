import * as format from './format.js';
import * as help from './help.js';
import * as log from './log.js';
import { buildPageTemplateManifestSchema, buildPartialManifestSchema } from './manifest-schema.js';

/**
 * `wonderpress manifest schema [partial|template]`.
 *
 * Prints the JSON Schema the CLI already builds and stamps into every theme,
 * so a consumer (the desktop app above all) validates manifests against the
 * schema of the CLI version the project pins, instead of carrying a copy that
 * drifts. Read-only and project-independent: the schema is a property of the
 * CLI, not of any theme.
 **/

const KINDS = {
	partial: buildPartialManifestSchema,
	template: buildPageTemplateManifestSchema,
};

export async function command(subcommand, args) {
	switch (subcommand) {
		case 'schema':
			return schema(args._[2]);
		default:
			// Same convention as `partial`: no subcommand shows the group, an
			// unknown one says so first.
			if (subcommand) {
				log.error(`Unknown manifest subcommand: ${subcommand}`);
				format.fail({
					code: 'unknown_command',
					message: `Unknown manifest subcommand: ${subcommand}`,
					hint: 'Run `wonderpress manifest help`.',
				});
			}
			help.show('manifest');
			return !subcommand;
	}
}

/**
 * Both schemas keyed by kind when none is named; the one schema object when
 * one is. Human mode prints the same JSON, pretty, because the only thing a
 * person does with a schema is read it or redirect it to a file.
 **/
export function schema(kind) {

	if (kind !== undefined && !KINDS[kind]) {
		log.error(`Unknown manifest kind: ${kind} (expected partial or template)`);
		return format.fail({
			code: 'usage',
			message: `Unknown manifest kind: ${kind}`,
			hint: 'Use `partial` or `template`, or omit it for both.',
		}, format.EXIT_USAGE);
	}

	const data = kind
		? KINDS[kind]()
		: { partial: KINDS.partial(), template: KINDS.template() };

	if (format.isJson()) {
		return format.ok(data);
	}

	log.raw(JSON.stringify(data, null, 2));
	return true;
}
