const core = require('./core');
const fs = require('fs');
const inquirer = require('inquirer');
const log = require('./log');
const mustache = require('mustache');
const sh = require('shelljs');
const staticCli = require('@wndrfl/static-kit-cli');
const wordpress = require('./wordpress');

/**
 * Accept and route a command.
 **/
export async function command(subcommand, args) {
  switch(subcommand) {
    case 'create':
      await create(args['--name'] || null, {
        dir : args['--dir'] || null,
      });
      break;
  }

  return true;
}

/**
 * Create a customer WordPress page template.
 **/
export async function create(templateName, opts) {

  if(!templateName) {
    log.error(`No name provided. Please provide a name by using the --name flag. Aborting template creation.`);
    return;
  }

  opts = opts || {};

  const dir = opts.dir || `${process.cwd()}/.`;

  process.chdir(dir);

  if(! await core.setCwdToEnvironmentRoot()) {
    return false;
  }

  const templateNameLower = templateName.toLowerCase();
  const templateNameParts = templateNameLower.replace(/[_-]/g,' ').split(" ");
  for (let i = 0; i < templateNameParts.length; i++) {
    templateNameParts[i] = templateNameParts[i][0].toUpperCase() + templateNameParts[i].substr(1);
  }
  const templateNameCapitalized = templateNameParts.join(" ");
  const templateNameFileFriendly = templateNameLower.replaceAll('_','-');
  const templateSlug = templateNameLower.replaceAll('_','-');

  const theme = await wordpress.getActiveTheme();
  const themeDir = await wordpress.pathToThemesDir + '/' + theme.name;

  const templatePath = require.resolve('./templates/template.mustache');
  const templateTemplate = fs.readFileSync(templatePath, 'utf8');
  const templateFilePath = themeDir;

  // Create the template
  const templateOutput = mustache.render(templateTemplate, {
    template_name : templateNameCapitalized,
    template_slug : templateSlug
  });
  const fileName = `template-${templateNameFileFriendly}.php`;
  const filePath = `${templateFilePath}/${fileName}`;
  await sh.exec(`cat > ${filePath} <<EOF
${templateOutput}`);
  log.success(`Template created: ${filePath}`);

  await staticCli.template.create(`${themeDir}/static`, templateNameFileFriendly);
}
