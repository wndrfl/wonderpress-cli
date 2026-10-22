/**
 * The README the CLI keeps at `.wonderpress/manifest/README.md`.
 *
 * The folder a person opens to edit a manifest sits beside folders only the
 * CLI writes (the schemas `$schema` points at, the sync locks). The README
 * says, in the folder itself, which is which, who writes each, and whether
 * to edit or commit it, so nobody has to remember. It is regenerated wherever the schemas are
 * (`ensureManifestSchemas()`: partial and template create, sync, agents
 * init), rewritten only when its text changes, and carries no version
 * number so a CLI release does not touch every theme's copy.
 */

import fs from 'fs-extra';
import path from 'path';
import {
	MANIFEST_ROOT,
	MANIFEST_SCHEMA_DIR,
	PAGE_TEMPLATE_MANIFEST_DIR,
	PARTIAL_LOCK_DIR,
	PARTIAL_MANIFEST_DIR,
} from './validate.js';

export const MANIFEST_README = `${MANIFEST_ROOT}/README.md`;

const under = (dir) => dir.replace(/^\.wonderpress\//, '');

/**
 * The README body. Paths are relative to `.wonderpress/`, the folder this
 * tree and the locks share.
 *
 * @returns {string}
 */
export function buildManifestReadme() {
	const partials = under(PARTIAL_MANIFEST_DIR);
	const templates = under(PAGE_TEMPLATE_MANIFEST_DIR);
	const schema = under(MANIFEST_SCHEMA_DIR);
	const locks = under(PARTIAL_LOCK_DIR);
	return `# Wonderpress manifests

This tree is the theme's contract with the Wonderpress CLI, Wonderpress Core,
and the desktop app. Two kinds of file live under \`.wonderpress/\`: the ones
you write, and the ones the CLI writes for you.

| Path | What it is | Written by | Edit it? | Commit it? |
| --- | --- | --- | --- | --- |
| \`${partials}/<slug>.json\` | A partial's contract: its properties and the files generated for it | You (\`partial create\` writes the first draft) | Yes | Yes |
| \`${templates}/<name>.json\` | A page template's editor contract and composition | You (\`template create\` writes the first draft) | Yes | Yes |
| \`${schema}/*.schema.json\` | The JSON Schema each manifest's \`$schema\` key points at, for editor completion and inline errors | The CLI, refreshed on create and sync | No | Yes, so \`$schema\` resolves on every checkout |
| \`${locks}/<slug>.json\` | Sync lock: hashes of what \`partial sync\` last wrote, so \`check-drift\` can tell a changed contract (pending) from hand-edited output (conflict) | \`partial sync\` and \`partial create\` | No | Yes |

Rule of thumb: everything under \`manifest/\` is yours. Everything else under
\`.wonderpress/\` belongs to the CLI.

After editing a partial manifest, run \`wonderpress partial sync <Name>\` to
regenerate the class and \`block.json\` from it. After editing a page-template
manifest, run \`wonderpress template validate\`.

This file is written by the Wonderpress CLI; edits to it are overwritten.
`;
}

/**
 * Write the README under the theme when its text differs from what is there.
 *
 * @param {string} themeDir Theme root.
 * @returns {string[]} The path, when written or refreshed.
 */
export function ensureManifestReadme(themeDir) {
	const file = path.join(themeDir, MANIFEST_README);
	const body = buildManifestReadme();
	if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) {
		return [];
	}
	fs.ensureDirSync(path.dirname(file));
	fs.writeFileSync(file, body);
	return [file];
}
