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

### [Commands](#commands)

The Wonderpress CLI provides different commands for many common tasks.

#### `wonderpress init`

Sets up (or initializes) a "Wonderpress" flavored WordPress Development Environment, configures and installs WordPress, installs various developer tools, and optionally installs a blank Wonderpress boilerplate theme.

#### `wonderpress lint [-f --fix]`

Lints the current active WordPress theme against the [Wonderpress Coding Standards](https://github.com/wndrfl/wonderpress-development-environment/blob/master/phpcs.xml) (which is a slightly modified flavor of the [WordPress Coding Standards](https://developer.wordpress.org/coding-standards/wordpress-coding-standards/php/)). Optionally, Wonderpress can attempt to automatically "fix" lightweight issues if the `fix` or `-f` arguments are passed.

#### `wonderpress readme create`

Starts a wizard to aid in the creation of a new README file.

#### `wonderpress partial create`

Create a Wonderpress "partial" (a PHP class and an accompanying view template) within the active Wonderpress-friendly theme, plus an agent-readable manifest and a delegated Static Kit style stub.

A partial is a rendering primitive (a button, a section) — it is **not** a Gutenberg block. A **block is definitionally a thin wrapper over a partial**: its `render.php` delegates to the partial class, so a block cannot exist without its partial, while a partial lives perfectly well without a block.

| Flag | Description |
| --- | --- |
| `--name <Class_Name>` | The partial's PHP class name (headless; omit for the wizard). |
| `--json <@file\|string>` | Create from a JSON spec instead of flags. |
| `--prop <name:type[:required]>` | Declare a property (repeatable). |
| `--acf` | Configure the partial as ACF compatible. |
| `--block` | Also expose the partial as a Gutenberg block (`block.json` + a `render.php` that delegates back to the partial). Opt-in. |
| `--js` | Also scaffold a JS behavior class for the partial (`static/src/js/lib/partials/<Name>.js`, delegated to Static Kit). Opt-in — most partials have no behavior. |
| `--template-name <name.php>` | Name the view template. |
| `--no-template` | Skip the view template. |
| `--no-style` | Skip the delegated SCSS style stub. |
| `--no-manifest` | Skip the manifest. |
| `--theme <name>` / `--dir <path>` | Target a specific theme / environment root. |

#### `wonderpress partial list`

List every partial in the theme (name, slug, and the block wrapping it, if any). Reads `.wonderpress/manifest/*.json` — the manifest directory is the CLI's index.

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

Create a Wonderpress custom page template.

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
