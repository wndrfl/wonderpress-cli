import fs from 'fs-extra';
import path from 'path';
import * as format from './format.js';
import * as log from './log.js';
import mustache from 'mustache';
import * as core from './core.js';
import * as help from './help.js';
import { pickOne } from './prompt.js';
import { resolveThemeDir } from './partial.js';
import * as staticCli from '@wndrfl/static-kit-cli';
import * as wordpress from './wordpress.js';
import {
  buildDefaultTemplateManifest,
  flattenTemplateComposition,
  parseSectionFlag,
  validateTemplateManifest,
  pageTemplateManifestDir,
  PAGE_TEMPLATE_MANIFEST_DIR,
  PARTIAL_MANIFEST_DIR,
  resolveWithin,
} from './validate.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
  switch (subcommand) {
    case 'create':
      await create(args['--name'] || null, {
        dir: args['--dir'] || null,
        theme: args['--theme'] || null,
        lock: args['--lock'] ?? null,
        sections: args['--section'] || [],
      });
      break;
    case 'list':
      await list(args);
      break;
    case 'remove':
      await remove(args);
      break;
    default:
      if (subcommand) {
        log.error(`Unknown template subcommand: ${subcommand}`);
        process.exitCode = format.EXIT_FAIL;
        format.fail({
          code: 'unknown_command',
          message: `Unknown template subcommand: ${subcommand}`,
          hint: 'Run `wonderpress template help`.',
        });
      }
      help.show('template');
      break;
  }

  return true;
}

/**
 * Normalize user input to a manifest basename (e.g. template-landing).
 **/
export function normalizePageTemplateKey(input) {
  let s = String(input).trim().toLowerCase().replace(/_/g, '-');
  s = s.replace(/\.(php|json)$/, '');
  if (!s.startsWith('template-')) {
    s = `template-${s}`;
  }
  return s;
}

/**
 * Rows for `template list`, read from page-template manifests.
 **/
export function listPageTemplates(themeDir) {
  const dir = pageTemplateManifestDir(themeDir);
  if (!fs.existsSync(dir)) {
    return [];
  }

  const rows = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) {
      continue;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }

    if (!data?.template || typeof data.template !== 'string') {
      continue;
    }

    rows.push({
      template: data.template,
      manifestFile: file,
      schemaVersion: data.schemaVersion ?? '—',
      sections: Array.isArray(data.composition) ? flattenTemplateComposition(data.composition).length : 0,
      lock: data.editor?.lock ?? '—',
    });
  }

  rows.sort((a, b) => a.template.localeCompare(b.template));
  return rows;
}

/**
 * Locate a page-template manifest by name, slug, or PHP filename.
 **/
export function findPageTemplateManifest(themeDir, query) {
  const key = normalizePageTemplateKey(query);
  const manifestRel = `${PAGE_TEMPLATE_MANIFEST_DIR}/${key}.json`;
  const manifestPath = resolveWithin(themeDir, manifestRel);

  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return { manifest, manifestPath, key };
    } catch {
      log.error(`Could not read manifest at ${manifestPath}. Fix or remove it by hand.`);
      return null;
    }
  }

  for (const row of listPageTemplates(themeDir)) {
    const rowKey = row.template.replace(/\.php$/, '');
    if (rowKey === key || row.template === query) {
      const altPath = resolveWithin(themeDir, `${PAGE_TEMPLATE_MANIFEST_DIR}/${row.manifestFile}`);
      if (!altPath) {
        continue;
      }
      try {
        const manifest = JSON.parse(fs.readFileSync(altPath, 'utf8'));
        return { manifest, manifestPath: altPath, key: rowKey };
      } catch {
        log.error(`Could not read manifest at ${altPath}. Fix or remove it by hand.`);
        return null;
      }
    }
  }

  return null;
}

function readStaticConfig(staticDir) {
  for (const name of ['.staticrc', '.static', 'statickit.json']) {
    const file = path.join(staticDir, name);
    if (!fs.existsSync(file)) {
      continue;
    }
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Static Kit entry paths for a template, relative to the theme directory.
 **/
export function staticTemplateEntryPaths(themeDir, templatePhpFile) {
  const fileFriendly = path.basename(templatePhpFile, '.php').replace(/^template-/, '');
  const staticDir = path.join(themeDir, 'static');
  const config = readStaticConfig(staticDir);
  if (!config?.paths?.src?.js || !config?.paths?.src?.scss) {
    return [];
  }

  const jsRel = `static/${config.paths.src.js}/${fileFriendly}.js`.replace(/\/+/g, '/');
  const scssRel = `static/${config.paths.src.scss}/${fileFriendly}.scss`.replace(/\/+/g, '/');
  return [jsRel, scssRel];
}

/**
 * Delete a page template and everything `template create` wrote for it.
 **/
export function removePageTemplate(themeDir, query, options = {}) {
  const found = findPageTemplateManifest(themeDir, query);
  if (!found) {
    log.error(`No page template named "${query}" is recorded in this theme. Run \`wonderpress template list\` to see what exists.`);
    return false;
  }

  const { manifest, manifestPath } = found;

  if (!manifest.template || typeof manifest.template !== 'string') {
    log.error(`The manifest at ${manifestPath} has no usable template filename. Fix the manifest before removing this template.`);
    return false;
  }

  const phpFile = resolveWithin(themeDir, manifest.template);
  if (!phpFile) {
    log.error(`Refusing to remove template "${manifest.template}": that path escapes the theme directory.`);
    return false;
  }

  if (fs.existsSync(phpFile)) {
    fs.removeSync(phpFile);
    log.success(`Removed template: ${phpFile}`);
  } else {
    log.warn(`Nothing to remove for template PHP: ${phpFile} does not exist.`);
  }

  if (!options.noStatic) {
    for (const rel of staticTemplateEntryPaths(themeDir, manifest.template)) {
      const file = resolveWithin(themeDir, rel);
      if (!file) {
        log.error(`Refusing to remove static entry "${rel}": that path escapes the theme directory. Skipping it.`);
        continue;
      }
      if (fs.existsSync(file)) {
        fs.removeSync(file);
        log.success(`Removed static entry: ${file}`);
      }
    }
  }

  fs.removeSync(manifestPath);
  log.success(`Removed manifest: ${manifestPath}`);
  return true;
}

/**
 * List page templates in the active (or selected) theme.
 **/
export async function list(args) {
  const themeDir = await resolveThemeDir(args);
  if (!themeDir) {
    return format.fail({
      code: 'theme',
      message: 'Could not resolve the theme directory',
      hint: 'Pass --theme <name> and --dir <env-root>.',
    });
  }

  const rows = listPageTemplates(themeDir);
  if (format.isJson()) {
    return format.ok({ templates: rows });
  }
  if (!rows.length) {
    log.info(`No page templates found in ${themeDir}. Create one with \`wonderpress template create --name <Name>\`.`);
    return true;
  }

  log.table(
    ['TEMPLATE', 'SECTIONS', 'LOCK', 'SCHEMA'],
    rows.map((row) => [row.template, String(row.sections), String(row.lock), String(row.schemaVersion)]),
  );
  log.info(`${rows.length} page template${rows.length === 1 ? '' : 's'}.`);
  return true;
}

/**
 * Remove a page template (`template remove <Name>`).
 **/
export async function remove(args) {
  const themeDir = await resolveThemeDir(args);
  if (!themeDir) {
    return false;
  }

  let name = args._ && args._[2] ? args._[2] : args['--name'];

  if (!name) {
    name = await pickOne({
      message: 'Which page template should be removed?',
      choices: listPageTemplates(themeDir).map((row) => ({
        name: `${row.template}  (${row.sections} section${row.sections === 1 ? '' : 's'})`,
        value: row.template,
      })),
      empty: 'This theme has no page templates to remove.',
      usage: 'Usage: wonderpress template remove <Name>.',
      args,
    });

    if (!name) {
      return false;
    }
  }

  return removePageTemplate(themeDir, name, { noStatic: !!args['--no-static'] });
}

/**
 * Create a customer WordPress page template.
 **/
export async function create(templateName, opts) {

  if (!templateName) {
    log.error(`No name provided. Please provide a name by using the --name flag. Aborting template creation.`);
    return;
  }

  opts = opts || {};

  const dir = opts.dir || `${process.cwd()}/.`;

  process.chdir(dir);

  if (! await core.setCwdToEnvironmentRoot()) {
    return false;
  }

  const templateNameLower = templateName.toLowerCase();
  const templateNameParts = templateNameLower.replace(/[_-]/g, ' ').split(" ");
  for (let i = 0; i < templateNameParts.length; i++) {
    templateNameParts[i] = templateNameParts[i][0].toUpperCase() + templateNameParts[i].substr(1);
  }
  const templateNameCapitalized = templateNameParts.join(" ");
  const templateNameFileFriendly = templateNameLower.replaceAll('_', '-');
  const templateSlug = templateNameLower.replaceAll('_', '-');

  let themeName = opts.theme || null;
  if (!themeName) {
    const theme = await wordpress.getActiveTheme();
    if (!theme?.name) {
      log.error('Could not determine the active theme. Pass --theme <name> (e.g. wonderpress).');
      return false;
    }
    themeName = theme.name;
  }
  const themeDir = `${wordpress.pathToThemesDir}/${themeName}`;

  const templateTemplate = fs.readFileSync(new URL('./templates/template.mustache', import.meta.url), 'utf8');
  const templateFilePath = themeDir;

  // Create the template
  const templateOutput = mustache.render(templateTemplate, {
    template_name: templateNameCapitalized,
    template_slug: templateSlug
  });
  const fileName = `template-${templateNameFileFriendly}.php`;
  const filePath = `${templateFilePath}/${fileName}`;
  fs.ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, templateOutput);
  log.success(`Template created: ${filePath}`);

  const manifestDir = pageTemplateManifestDir(themeDir);
  fs.ensureDirSync(manifestDir);

  const sections = [];
  for (const raw of opts.sections || []) {
    try {
      sections.push(parseSectionFlag(raw));
    } catch (err) {
      log.error(err.message);
      return false;
    }
  }

  let lock = opts.lock ?? 'all';
  if (lock === 'false') {
    lock = false;
  }

  const manifestPayload = buildDefaultTemplateManifest(fileName, { lock, sections });
  const partialSlugs = await loadPartialSlugs(themeDir);
  const validated = validateTemplateManifest(manifestPayload, { partialSlugs });
  if (!validated.ok) {
    for (const msg of validated.errors) {
      log.error(msg);
    }
    return false;
  }

  const manifestPath = `${manifestDir}/${fileName.replace(/\.php$/, '.json')}`;
  fs.writeFileSync(manifestPath, JSON.stringify(validated.data, null, 2) + '\n');
  log.success(`Template manifest created: ${manifestPath}`);

  await staticCli.template.create(`${themeDir}/static`, templateNameFileFriendly);

  try {
    const agents = await import('./agents.js');
    agents.writeAgentFiles({ root: process.cwd(), themeDir });
  } catch (err) {
    log.warn(`Could not refresh AGENTS.md: ${err.message}`);
  }

  if (format.isJson()) {
    return format.ok({
      template: fileName,
      lock: validated.data.editor?.lock ?? null,
      sections: flattenTemplateComposition(validated.data.composition || []).length,
    });
  }

  return true;
}

/**
 * Slugs from `.wonderpress/manifest/partials/*.json` for validation.
 **/
async function loadPartialSlugs(themeDir) {
  const manifestDir = `${themeDir}/${PARTIAL_MANIFEST_DIR}`;
  if (!fs.existsSync(manifestDir)) {
    return [];
  }
  const slugs = [];
  for (const file of fs.readdirSync(manifestDir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(`${manifestDir}/${file}`, 'utf8'));
      if (data?.slug) {
        slugs.push(data.slug);
      }
    } catch {
      // skip unreadable manifests
    }
  }
  return slugs;
}
