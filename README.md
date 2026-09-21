# ✨Wonderpress CLI
A commandline interface for bootstrapping and working with the Wonderpress-flavored WordPress development environment.

## Table of Contents

1.  [Documentation](#documentation)
    1.  [Installation](#installation)
    2.  [Commands](#commands)
2.  [Architecture](#architecture)
3.  [Support](#support)
4.  [Known issues](#issues)
5.  [License](#license)

## [Documentation](#documentation)

### [Installation](#installation)

Using npm:

```shell
$ npm install -g @wndrfl/wonderpress-cli
```

### Starting a project

Installing the CLI is not the same as knowing what order to do things in.
**[docs/getting-started.md](docs/getting-started.md)** walks through building an
environment, setting up design tokens, curating the editor and locking pages —
and flags the one decision (the block namespace) that cannot be taken back once
a client has pages.

### [Commands](#commands)

The Wonderpress CLI provides different commands for many common tasks.

The CLI documents itself, so this list is a reference rather than the only way
to find a command:

```bash
wonderpress                  # what commands exist
wonderpress partial help     # detail on one of them
wonderpress block help       # ...including how blocks relate to partials
```

#### `wonderpress init`

Sets up (or initializes) a "Wonderpress" flavored WordPress Development Environment, configures and installs WordPress, installs various developer tools, and optionally installs a blank Wonderpress boilerplate theme.

#### `wonderpress lint [-f --fix]`

Lints the current active WordPress theme against the [Wonderpress Coding Standards](https://github.com/wndrfl/wonderpress-development-environment/blob/master/phpcs.xml) (phpcs) **and** `partial check-drift`. Optionally, Wonderpress can attempt to automatically "fix" lightweight phpcs issues if the `fix` or `-f` arguments are passed. `--format json` prints `{ ok, data, error }`. `--axe` and `--budget` are reserved (currently skipped).

Exit codes: `0` success, `1` phpcs or drift failure, `2` usage (for example, which theme is ambiguous).

#### `wonderpress agents write`

Writes `AGENTS.md` at the environment root from conventions plus live manifests, and a one-line `CLAUDE.md` that points at it. Regenerated after `init`, `partial create` / `sync`, and `template create`.

#### `wonderpress mcp`

Starts an MCP stdio server in this package. Tools call the same operations as the CLI. See `wonderpress mcp help`.

#### `wonderpress readme create`

Starts a wizard to aid in the creation of a new README file.

#### `wonderpress partial create`

Create a Wonderpress "partial" (a PHP class and an accompanying view template) within the active Wonderpress-friendly theme, plus an agent-readable manifest and a delegated Static Kit style stub.

A partial is a rendering primitive (a button, a section) — it is **not** a Gutenberg block. A **block is definitionally a thin wrapper over a partial**: its `render.php` delegates to the partial class, so a block cannot exist without its partial, while a partial lives perfectly well without a block.

| Flag | Description |
| --- | --- |
| `--name <Class_Name>` | The partial's PHP class name (headless; omit for the wizard). |
| `--json <@file\|string>` | Create from a JSON spec instead of flags. |
| `--prop <name:type[:required]>` | Declare a property (repeatable). Types: `string`, `boolean`, `image`, `link`, `repeater`, `array`, `object`. |
| `--sub <parent:name:type[:required]>` | A sub-field of a repeater (repeatable). |
| `--acf` | Mark the partial ACF compatible. Core registers a field group from the manifest when ACF is present and the partial is located (template composition or `wonderpress_template_fields`). Cannot be combined with `--no-manifest`. |
| `--block` | Also expose the partial as a Gutenberg block (`block.json` + a `render.php` that delegates back to the partial). Opt-in. |
| `--js` | Also scaffold a JS behavior class for the partial (`static/src/js/lib/partials/<Name>.js`, delegated to Static Kit). Opt-in — most partials have no behavior. |
| `--template-name <name.php>` | Name the view template. |
| `--no-template` | Skip the view template. |
| `--no-style` | Skip the delegated SCSS style stub. |
| `--no-manifest` | Skip the manifest. Cannot be combined with `--block` or `--acf`. |
| `--theme <name>` / `--dir <path>` | Target a specific theme / environment root. |

Three combinations are worth knowing: `--block --no-manifest` is refused (the
manifest is the index that makes a block manageable), `--acf --no-manifest` is
refused (core reads the manifest to register the field group), and
`--js --no-template` emits no behavior class, because a behavior stub is only
scaffolded for a partial that renders a view. `--block` and `--acf` may be
combined: the block uses Gutenberg attributes, the PHP caller uses ACF. Do not
locate the ACF group on a page that also inserts the block.

#### `wonderpress partial list`

List every partial in the theme (name, slug, and the block wrapping it, if any). Reads `.wonderpress/manifest/partials/*.json` — the partial manifest directory is the CLI's index.

#### `wonderpress partial remove <Name>`

Remove a partial and every artifact its manifest records (class, view template, style stub, behavior class), then the manifest itself. Accepts a class name (`Call_To_Action`) or a slug (`call-to-action`).

If a block wraps the partial the removal is refused — run `wonderpress block remove <Name>` first, or pass `--with-block` to remove both.

#### `wonderpress block create <Name>`

Retrofit a Gutenberg block onto an existing partial: emits `blocks/<slug>/block.json` and a `render.php` that delegates to the partial, and records the block in the partial's manifest. The output is identical to having passed `--block` at creation time.

A block needs a partial to wrap, so if none exists the command tells you to run `wonderpress partial create --name <Name> --block` instead of scaffolding a partial with no properties.

#### `wonderpress block list`

List every block in the theme, with the partial backing it.

#### `wonderpress block remove <Name>`

Remove a block's directory and strip it from the manifest. The backing partial is left untouched.

#### `wonderpress server`

Starts a web server to run WordPress locally. (uses [WP CLI](https://developer.wordpress.org/cli/commands/server/))

#### `wonderpress template create`

Create a Wonderpress custom page template, a matching `.wonderpress/manifest/page-templates/*.json`
manifest (`schemaVersion` 1), and Static Kit page assets. Optional `--lock` and
repeatable `--section id:partial` seed composition.

#### `wonderpress template list`

List page templates recorded under `.wonderpress/manifest/page-templates/`.

#### `wonderpress template remove <Name>`

Remove the template PHP file, its manifest, and the delegated Static Kit JS/SCSS
entries (pass `--no-static` to keep static files).

## [Architecture](#architecture)

WonderPress consumes [Static Kit](https://github.com/wndrfl/static-kit) as a
dependency and delegates everything under the theme's `static/` directory to it
— which is why Static Kit's `node_modules` is installed by the CLI, never
committed. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full ownership
contract.

### [Support](#support)

The CLI has been tested on the following tools. Please let us know if how it works in your environment!

- **Mac OS**:
  - Terminal.app
  - iTerm
- **Windows**:
  - (needs testing, please let us know how it works!)
- **Linux**:
  - (needs testing, please let us know how it works!)

### [Known Issues](#issues)

Currently there are no known issues. However, if you experience something, we certainly want to know! Please submit a Github issue.

### [License](#license)

Copyright (c) 2021 Wonderful
Licensed under the MIT license.

## Collaborators
- Johnnie Munger johnnie@wonderful.io
