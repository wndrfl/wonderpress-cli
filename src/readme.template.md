# {{ project_name }}
{{# has_github }}
 
[![wonderpress-coding-standards Status]({{ github_url }}/workflows/wonderpress-coding-standards/badge.svg)]({{ github_url }}/actions)

{{/ has_github }}
{{ project_description }}

## Environments

| Environment | Branch  | URL                          	|
|-------------|---------|-------------------------------|
| Production  | master  | {{ production_url }}          |
| Staging     | staging | {{ stage_url }}  				|
| Development | develop | {{ dev_url }}      			|

## Wonderpress

This environment is compatible with the [Wonderpress CLI](https://www.npmjs.com/package/@wndrfl/wonderpress-cli), which provides a suite of tools to make development within this environment a breeze.

To install the Wonderpress CLI:

\`$ npm -i @wndrfl/wonderpress-cli -g\`

For quick access to many Wonderpress features:

\`\`\`
$ cd /path/to/project
$ wonderpress
\`\`\`

To learn more about the features of the Wonderpress CLI, check out [the documentation](https://www.npmjs.com/package/@wndrfl/wonderpress-cli).

## Development Workflow

### Default Branch

\`master\`

### Branch naming convention

- For bugs - \`fix/issue-name\` For example, \`fix/syntax-errors\`
- For features - \`feature/feature-name\` For example, \`feature/home-page\`

### Coding Standards and Linting

This environment is automatically codesniffed against the [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/) when pushed to Github.

To run codesniffing locally, you may use the Wonderpress \`lint\` command:

\`$ wonderpress lint\`