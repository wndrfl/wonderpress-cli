import fs from 'fs-extra';
import path from 'path';
import * as log from './log.js';
import mustache from 'mustache';
import * as core from './core.js';
import inquirer from 'inquirer';
import * as staticCli from '@wndrfl/static-kit-cli';
import * as wordpress from './wordpress.js';

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
  switch (subcommand) {
    case 'create':
      await create(args['--name'] || null, {
        dir: args['--dir'] || null,
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

  await staticCli.template.create(`${themeDir}/static`, templateNameFileFriendly);
}
