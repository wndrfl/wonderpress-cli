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

## Development Workflow

### Default Branch

\`master\`

### Branch naming convention

- For bugs - \`fix/issue-name\` For example, \`fix/syntax-errors\`
- For features - \`feature/feature-name\` For example, \`feature/home-page\`

### Coding Standards and Linting

This environment is automatically codesniffed against the [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/) when pushed to Github.

To run codesniffing locally:

\`$ wonderpress lint\`