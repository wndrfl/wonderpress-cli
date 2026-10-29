import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as format from './format.js';
import * as log from './log.js';
import * as partial from './partial.js';
import * as block from './block.js';
import * as template from './template.js';
import * as lint from './lint.js';
import { checkPartialDrift } from './partial-drift.js';
import { classNameToSlug, nameToSlug } from './validate.js';
import pkg from '../package.json' with { type: 'json' };

const mcpIconPng = fs.readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets/mcp-icon.png'),
);

const loc = {
	dir: z.string().optional().describe('Wonderpress environment root'),
	theme: z.string().optional().describe('Theme directory name'),
};

function jsonResult(data) {
	return {
		content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
	};
}

function jsonError(message, extra = {}) {
	return {
		isError: true,
		content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { message, ...extra } }, null, 2) }],
	};
}

export async function resolveMcpThemeDir(input = {}) {
	const args = {};
	if (input.dir) {
		args['--dir'] = input.dir;
	}
	if (input.theme) {
		args['--theme'] = input.theme;
	}
	return partial.resolveThemeDir(args);
}

export const handlers = {
	async partial_list(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory', { hint: 'Pass theme and dir.' });
		}
		return jsonResult({ ok: true, partials: partial.listPartials(themeDir) });
	},

	async block_list(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		return jsonResult({ ok: true, blocks: block.listBlocks(themeDir) });
	},

	async template_list(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		return jsonResult({ ok: true, templates: template.listPageTemplates(themeDir) });
	},

	async partial_get(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		if (!input.slug) {
			return jsonError('slug is required');
		}
		const manifest = partial.readManifest(themeDir, input.slug);
		if (!manifest) {
			return jsonError(`No partial manifest for "${input.slug}"`);
		}
		return jsonResult({ ok: true, manifest });
	},

	async partial_check_drift(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		const manifests = input.slug
			? [partial.readManifest(themeDir, input.slug)].filter(Boolean)
			: partial.readManifests(themeDir);
		if (input.slug && !manifests.length) {
			return jsonError(`No partial manifest for "${input.slug}"`);
		}
		const results = manifests.map((manifest) => checkPartialDrift(manifest, themeDir));
		const ok = results.every((r) => r.ok);
		// `partials` (slug, state, changes) is the contract, the same shape as
		// `partial check-drift --format json`; `results` stays for older callers.
		return jsonResult({ ok, partials: results.map(partial.driftSummary), results });
	},

	async lint_theme(input = {}) {
		const inspected = await lint.inspectTheme(input.dir || process.cwd(), {
			name: input.theme,
			fix: input.fix === true,
		});
		if (!inspected.ok && !inspected.data) {
			return jsonError(inspected.error?.message || 'lint failed', inspected.error || {});
		}
		return jsonResult({ ok: inspected.ok, ...(inspected.data || {}) });
	},

	async partial_create(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		if (!input.spec) {
			return jsonError('spec is required (same shape as wonderpress partial create --json)');
		}
		try {
			const spec = typeof input.spec === 'string' ? input.spec : JSON.stringify(input.spec);
			const params = partial.paramsFromJson(spec);
			partial.validateParams(params, themeDir);
			params.namespace = partial.resolveNamespace(themeDir);
			const written = await partial.writePartial(params, themeDir, { force: input.force === true });
			const { writeAgentFiles } = await import('./agents.js');
			writeAgentFiles({ root: process.cwd(), themeDir });
			return jsonResult({
				ok: true,
				name: params.class_name,
				slug: classNameToSlug(params.class_name),
				// Same field as `partial create --format json`: halves Static
				// Kit could not write, absent when every requested half landed.
				...(written.warnings.length ? { warnings: written.warnings } : {}),
			});
		} catch (err) {
			// A re-create refused over a conflict (or a fence refusal) keeps its
			// code + hint, the same as partial_sync.
			return jsonError(err.message, err.code ? { code: err.code, hint: err.hint } : {});
		}
	},

	async partial_sync(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		const dryRun = input.dryRun === true;
		const force = input.force === true;
		const syncAll = input.all === true || !input.name;
		try {
			if (syncAll) {
				const manifests = partial.readManifests(themeDir);
				const plans = [];
				const synced = [];
				const skipped = [];
				for (const manifest of manifests) {
					let result;
					try {
						result = partial.syncPartialFromManifest(manifest, themeDir, { dryRun, force });
					} catch (err) {
						// Same as the CLI's --all: a conflicted partial is skipped,
						// not allowed to abort the rest.
						// A lock-less class the writer refuses (FenceError) is
						// skipped the same way, under its own code.
						if (err instanceof partial.SyncConflictError || err instanceof partial.FenceError) {
							skipped.push({ slug: manifest.slug, code: err.code, message: err.message, changes: err.changes });
							continue;
						}
						throw err;
					}
					if (dryRun && result && result.slug) {
						plans.push(result);
					} else if (!dryRun) {
						synced.push(manifest.slug);
					}
				}
				if (!dryRun) {
					const { writeAgentFiles } = await import('./agents.js');
					writeAgentFiles({ root: process.cwd(), themeDir });
				}
				return jsonResult({
					ok: true,
					dryRun,
					synced: dryRun ? undefined : synced,
					skipped: dryRun ? undefined : skipped,
					plans: dryRun ? plans : undefined,
				});
			}
			const manifest = partial.readManifest(themeDir, nameToSlug(input.name));
			if (!manifest) {
				return jsonError(`No partial manifest for "${input.name}"`);
			}
			const result = partial.syncPartialFromManifest(manifest, themeDir, { dryRun, force });
			if (!dryRun) {
				const { writeAgentFiles } = await import('./agents.js');
				writeAgentFiles({ root: process.cwd(), themeDir });
			}
			return jsonResult({ ok: true, dryRun, plan: dryRun ? result : undefined, synced: dryRun ? undefined : [manifest.slug] });
		} catch (err) {
			// A fence refusal carries a code + hint (e.g. class_unfenced, re-run
			// with force) so an agent can tell it apart from a broken manifest.
			return jsonError(err.message, err.code ? { code: err.code, hint: err.hint } : {});
		}
	},

	async block_create(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		if (!input.name) {
			return jsonError('name is required');
		}
		let added;
		try {
			added = block.addBlock(themeDir, input.name, { force: input.force === true });
		} catch (err) {
			if (!(err instanceof partial.SyncConflictError)) {
				throw err;
			}
			return jsonError(err.message, { code: err.code, hint: err.hint });
		}
		if (!added) {
			return jsonError(`Could not wrap "${input.name}" in a block`);
		}
		const { writeAgentFiles } = await import('./agents.js');
		writeAgentFiles({ root: process.cwd(), themeDir });
		return jsonResult({ ok: true, name: input.name });
	},

	async partial_add_js(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		if (!input.name) {
			return jsonError('name is required');
		}
		const warnings = [];
		if (!await partial.addScript(themeDir, input.name, { warnings })) {
			return jsonError(warnings.length ? `Could not add JS to "${input.name}": ${warnings.join(' ')}` : `Could not add JS to "${input.name}"`);
		}
		const { writeAgentFiles } = await import('./agents.js');
		writeAgentFiles({ root: process.cwd(), themeDir });
		const slug = nameToSlug(input.name);
		const manifest = partial.readManifest(themeDir, slug);
		return jsonResult({
			ok: true,
			name: manifest?.name || input.name,
			slug: manifest?.slug || slug,
			script: manifest?.artifacts?.script || null,
		});
	},

	async template_create(input = {}) {
		if (!input.name) {
			return jsonError('name is required');
		}
		const ok = await template.create(input.name, {
			dir: input.dir || process.cwd(),
			theme: input.theme,
			lock: input.lock ?? null,
			sections: input.sections || [],
		});
		if (!ok) {
			return jsonError(`Could not create template "${input.name}"`);
		}
		return jsonResult({ ok: true, name: input.name });
	},

	async partial_remove(input = {}) {
		if (input.confirm !== true) {
			return jsonError('Refusing to remove without confirm: true');
		}
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		if (!input.name) {
			return jsonError('name is required');
		}
		const ok = await partial.removePartial(themeDir, input.name, { withBlock: !!input.withBlock });
		if (!ok) {
			return jsonError(`Could not remove partial "${input.name}"`);
		}
		return jsonResult({ ok: true, name: input.name });
	},

	async block_remove(input = {}) {
		if (input.confirm !== true) {
			return jsonError('Refusing to remove without confirm: true');
		}
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		if (!input.name) {
			return jsonError('name is required');
		}
		const ok = block.removeBlock(themeDir, input.name);
		if (!ok) {
			return jsonError(`Could not remove block "${input.name}"`);
		}
		return jsonResult({ ok: true, name: input.name });
	},
};

export function mcpServerInfo() {
	return {
		name: 'wonderpress',
		title: 'Wonderpress',
		version: pkg.version,
		description:
			'Exposes the same deterministic CLI operations as Model Context Protocol tools so an agent is a second client of the CLI, not a second codebase.',
		websiteUrl: 'https://wonderpress.dev',
		icons: [
			{
				src: `data:image/png;base64,${mcpIconPng.toString('base64')}`,
				mimeType: 'image/png',
				sizes: ['180x180'],
			},
		],
	};
}

export function createWonderpressMcpServer() {
	const server = new McpServer(mcpServerInfo());

	const locShape = { dir: loc.dir, theme: loc.theme };

	server.registerTool('partial_list', {
		description: 'List Wonderpress partials in the theme (manifest index).',
		inputSchema: locShape,
	}, (args) => handlers.partial_list(args));

	server.registerTool('block_list', {
		description: 'List Gutenberg blocks wrapping Wonderpress partials.',
		inputSchema: locShape,
	}, (args) => handlers.block_list(args));

	server.registerTool('template_list', {
		description: 'List page-template manifests.',
		inputSchema: locShape,
	}, (args) => handlers.template_list(args));

	server.registerTool('partial_get', {
		description: 'Read one partial manifest by slug.',
		inputSchema: { ...locShape, slug: z.string() },
	}, (args) => handlers.partial_get(args));

	server.registerTool('partial_check_drift', {
		description: 'Report each partial\'s sync state against its sync lock: partials[] of { slug, state: clean | pending | conflict, changes[] { artifact: manifest | class | block, region: fence | file | null, kind, state, message } }. pending = the manifest changed (or no lock yet) and partial_sync is safe; conflict = generated output (the class\'s fenced region or block.json) was edited by hand, and partial_sync refuses it unless force is true. ok is false on conflict or when generated files no longer match the manifest.',
		inputSchema: { ...locShape, slug: z.string().optional() },
	}, (args) => handlers.partial_check_drift(args));

	server.registerTool('lint_theme', {
		description: 'Run phpcs, partial check-drift, and page-template validation on the theme. Pass fix: true to run phpcbf (CLI --fix / -f), including auto-fixable warnings that do not fail phpcs; does not repair drift (use partial_sync) or template errors (edit the manifest or PHP).',
		inputSchema: {
			...locShape,
			fix: z.boolean().optional().describe('Run phpcbf on the theme (CLI --fix / -f) when phpcs reports errors or auto-fixable warnings. Does not repair drift; use partial_sync.'),
		},
	}, (args) => handlers.lint_theme(args));

	server.registerTool('partial_create', {
		description: 'Create a partial from a JSON spec (same as CLI --json). Re-creating an existing partial that is in conflict (hand edits inside the class fence or in block.json since the last sync) is refused with code "conflict" unless force is true.',
		inputSchema: {
			...locShape,
			spec: z.unknown(),
			force: z.boolean().optional().describe('Overwrite hand edits in the generated output of an existing partial (CLI --force).'),
		},
	}, (args) => handlers.partial_create(args));

	server.registerTool('partial_sync', {
		description: 'Regenerate class and block.json from manifests and record the sync lock. Only the class region between // <wonderpress:generated> markers is rewritten; custom PHP below the closing marker survives. A partial in conflict (hand edits inside the fence or in block.json since the last sync; see partial_check_drift) is refused with code "conflict" unless force is true; with all, conflicted partials are skipped and listed in skipped[]. A legacy class without markers that was hand-edited is refused unless force is true.',
		inputSchema: {
			...locShape,
			name: z.string().optional(),
			all: z.boolean().optional(),
			dryRun: z.boolean().optional(),
			force: z.boolean().optional().describe('Override refusals (CLI --force): overwrite hand edits in the fenced region or block.json, and rewrite a whole class file that has no or malformed markers. Code outside an intact fence is still kept.'),
		},
	}, (args) => handlers.partial_sync(args));

	server.registerTool('block_create', {
		description: 'Wrap an existing partial in a Gutenberg block. If block.json was edited by hand since the last sync, it is refused with code "conflict" unless force is true.',
		inputSchema: {
			...locShape,
			name: z.string(),
			force: z.boolean().optional().describe('Overwrite a hand-edited block.json (CLI --force).'),
		},
	}, (args) => handlers.block_create(args));

	server.registerTool('partial_add_js', {
		description: 'Scaffold a JS behavior class onto an existing partial (same as --js at create).',
		inputSchema: { ...locShape, name: z.string() },
	}, (args) => handlers.partial_add_js(args));

	server.registerTool('template_create', {
		description: 'Create a page template PHP file and manifest. After create, edit those two files together (see AGENTS.md); this tool does not update an existing template.',
		inputSchema: {
			...locShape,
			name: z.string(),
			lock: z.union([z.string(), z.boolean()]).optional(),
			sections: z.array(z.string()).optional(),
		},
	}, (args) => handlers.template_create(args));

	server.registerTool('partial_remove', {
		description: 'Remove a partial. Requires confirm: true.',
		inputSchema: {
			...locShape,
			name: z.string(),
			confirm: z.boolean(),
			withBlock: z.boolean().optional(),
		},
	}, (args) => handlers.partial_remove(args));

	server.registerTool('block_remove', {
		description: 'Remove a block wrapper. Requires confirm: true. Leaves the partial.',
		inputSchema: {
			...locShape,
			name: z.string(),
			confirm: z.boolean(),
		},
	}, (args) => handlers.block_remove(args));

	server.resource(
		'partial-manifest',
		new ResourceTemplate('manifest://partials/{slug}', {
			list: async () => {
				try {
					const themeDir = await resolveMcpThemeDir({});
					if (!themeDir) {
						return { resources: [] };
					}
					return {
						resources: partial.readManifests(themeDir).map((manifest) => ({
							uri: `manifest://partials/${manifest.slug}`,
							name: manifest.name,
							mimeType: 'application/json',
						})),
					};
				} catch {
					return { resources: [] };
				}
			},
		}),
		async (uri, { slug }) => {
			const themeDir = await resolveMcpThemeDir({});
			const manifest = themeDir ? partial.readManifest(themeDir, slug) : null;
			return {
				contents: [{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(manifest || { error: `No partial "${slug}"` }, null, 2),
				}],
			};
		},
	);

	server.resource(
		'page-template-manifest',
		new ResourceTemplate('manifest://page-templates/{id}', {
			list: async () => {
				try {
					const themeDir = await resolveMcpThemeDir({});
					if (!themeDir) {
						return { resources: [] };
					}
					return {
						resources: template.listPageTemplates(themeDir).map((row) => ({
							uri: `manifest://page-templates/${row.manifestFile.replace(/\.json$/, '')}`,
							name: row.template,
							mimeType: 'application/json',
						})),
					};
				} catch {
					return { resources: [] };
				}
			},
		}),
		async (uri, { id }) => {
			const themeDir = await resolveMcpThemeDir({});
			const found = themeDir ? template.findPageTemplateManifest(themeDir, id) : null;
			return {
				contents: [{
					uri: uri.href,
					mimeType: 'application/json',
					text: JSON.stringify(found?.manifest || { error: `No page template "${id}"` }, null, 2),
				}],
			};
		},
	);

	return server;
}

export async function command() {
	format.setMcp();
	const server = createWonderpressMcpServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	log.info('Wonderpress MCP server listening on stdio');
}
