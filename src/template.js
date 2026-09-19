import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';
import mustache from 'mustache';
import * as core from './core.js';
import inquirer from 'inquirer';
import * as staticCli from '@wndrfl/static-kit-cli';
import * as wordpress from './wordpress.js';
import {
  buildDefaultTemplateManifest,
  parseSectionFlag,
  validateTemplateManifest,
  pageTemplateManifestDir,
  PARTIAL_MANIFEST_DIR,
} from './validate.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
  switch (subcommand) {
    case 'create':
      await create(args['--name'] || null, {
        dir: args['--dir'] || null,
        lock: args['--lock'] ?? null,
        sections: args['--section'] || [],
      });
      break;
  }

  return true;
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

  const theme = await wordpress.getActiveTheme();
  const themeDir = await wordpress.pathToThemesDir + '/' + theme.name;

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
