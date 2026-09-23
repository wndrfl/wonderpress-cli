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
	dir: z.string().optional().describe('WonderPress environment root'),
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
		return jsonResult({ ok, results });
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
			await partial.writePartial(params, themeDir);
			const { writeAgentFiles } = await import('./agents.js');
			writeAgentFiles({ root: process.cwd(), themeDir });
			return jsonResult({
				ok: true,
				name: params.class_name,
				slug: classNameToSlug(params.class_name),
			});
		} catch (err) {
			return jsonError(err.message);
		}
	},

	async partial_sync(input = {}) {
		const themeDir = await resolveMcpThemeDir(input);
		if (!themeDir) {
			return jsonError('Could not resolve the theme directory');
		}
		const dryRun = input.dryRun === true;
		const syncAll = input.all === true || !input.name;
		try {
			if (syncAll) {
				const manifests = partial.readManifests(themeDir);
				const plans = [];
				for (const manifest of manifests) {
					const result = partial.syncPartialFromManifest(manifest, themeDir, { dryRun });
					if (dryRun && result && result.slug) {
						plans.push(result);
					}
				}
				if (!dryRun) {
					const { writeAgentFiles } = await import('./agents.js');
					writeAgentFiles({ root: process.cwd(), themeDir });
				}
				return jsonResult({
					ok: true,
					dryRun,
					synced: dryRun ? undefined : manifests.map((m) => m.slug),
					plans: dryRun ? plans : undefined,
				});
			}
			const manifest = partial.readManifest(themeDir, nameToSlug(input.name));
			if (!manifest) {
				return jsonError(`No partial manifest for "${input.name}"`);
			}
			const result = partial.syncPartialFromManifest(manifest, themeDir, { dryRun });
			if (!dryRun) {
				const { writeAgentFiles } = await import('./agents.js');
				writeAgentFiles({ root: process.cwd(), themeDir });
			}
			return jsonResult({ ok: true, dryRun, plan: dryRun ? result : undefined, synced: dryRun ? undefined : [manifest.slug] });
		} catch (err) {
			return jsonError(err.message);
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
		if (!block.addBlock(themeDir, input.name)) {
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
		if (!await partial.addScript(themeDir, input.name)) {
			return jsonError(`Could not add JS to "${input.name}"`);
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
		const ok = partial.removePartial(themeDir, input.name, { withBlock: !!input.withBlock });
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
		title: 'WonderPress',
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
		description: 'List WonderPress partials in the theme (manifest index).',
		inputSchema: locShape,
	}, (args) => handlers.partial_list(args));

	server.registerTool('block_list', {
		description: 'List Gutenberg blocks wrapping WonderPress partials.',
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
		description: 'Fail when class or block.json drifted from the manifest.',
		inputSchema: { ...locShape, slug: z.string().optional() },
	}, (args) => handlers.partial_check_drift(args));

	server.registerTool('lint_theme', {
		description: 'Run phpcs and partial check-drift on the theme. Pass fix: true to run phpcbf (CLI --fix / -f); does not repair manifest drift (use partial_sync).',
		inputSchema: {
			...locShape,
			fix: z.boolean().optional().describe('Run phpcbf on the theme (CLI --fix / -f). Only runs when phpcs failed. Does not repair drift; use partial_sync.'),
		},
	}, (args) => handlers.lint_theme(args));

	server.registerTool('partial_create', {
		description: 'Create a partial from a JSON spec (same as CLI --json).',
		inputSchema: { ...locShape, spec: z.unknown() },
	}, (args) => handlers.partial_create(args));

	server.registerTool('partial_sync', {
		description: 'Regenerate class and block.json from manifests.',
		inputSchema: {
			...locShape,
			name: z.string().optional(),
			all: z.boolean().optional(),
			dryRun: z.boolean().optional(),
		},
	}, (args) => handlers.partial_sync(args));

	server.registerTool('block_create', {
		description: 'Wrap an existing partial in a Gutenberg block.',
		inputSchema: { ...locShape, name: z.string() },
	}, (args) => handlers.block_create(args));

	server.registerTool('partial_add_js', {
		description: 'Scaffold a JS behavior class onto an existing partial (same as --js at create).',
		inputSchema: { ...locShape, name: z.string() },
	}, (args) => handlers.partial_add_js(args));

	server.registerTool('template_create', {
		description: 'Create a page template and its manifest.',
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
	log.info('WonderPress MCP server listening on stdio');
}
