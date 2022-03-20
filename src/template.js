import inquirer from 'inquirer';

const core = require('./core');
const fs = require('fs');
const log = require('./log');
const mustache = require('mustache');
const sh = require('shelljs');
const wordpress = require('./wordpress');

export async function command(subcommand, args) {
  switch(subcommand) {
    case 'create':
      await create({
        dir : args['--dir'] || null,
        name : args['--name'] || null,
      });
      break;
  }

  return true;
}

export async function create(opts) {

  const dir = opts.dir || `${process.cwd()}/.`;

  process.chdir(dir);

  if(! await core.setCwdToEnvironmentRoot()) {
    return false;
  }

  const templateName = opts.name || null;
  if(!templateName) {
    log.error(`No name provided. Please provide a name by using the --name flag. Aborting template creation.`);
    return;
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
}
