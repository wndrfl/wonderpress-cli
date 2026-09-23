wonderpress readme — generate a project README

Writes README.md at the environment root. Flag-driven first: any --project-*
flag (or --json) creates it headlessly; otherwise the wizard collects the
same fields. Skips if a README already exists.

COMMANDS
  readme create            Write README.md

OPTIONS
  --project-name <name>
  --project-description <text>
  --github-url <url>
  --production-url <url>
  --stage-url <url>
  --dev-url <url>
  --json <spec|@file>      Create from a JSON spec instead of flags
  --dir <path>             Environment root

EXAMPLES
  wonderpress readme create
  wonderpress readme create --project-name Acme --github-url https://github.com/acme/site
