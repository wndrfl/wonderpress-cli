# Wonderpress CLI

Command-line tooling for **Wonderpress**: a WordPress theme development environment with a manifest-first authoring model.

The CLI bootstraps a local environment, scaffolds partials / blocks / page templates, keeps generated code in sync with manifests, and exposes the same operations to agents over MCP.

```bash
npm install -g @wndrfl/wonderpress-cli
```

Requires **Node.js 24+**.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Command reference](#command-reference)
- [Machine-readable output](#machine-readable-output)
- [Architecture](#architecture)
- [Further reading](#further-reading)
- [License](#license)

---

## What it does

Wonderpress treats a **partial** as the unit of markup: a PHP class, a view, and a JSON manifest. A Gutenberg **block** is an optional thin wrapper whose `render.php` delegates back to that partial. Page **templates** compose partials and record editor locks in their own manifests.

The CLI is the only supported way to create and maintain that graph. Interactive wizards exist for humans; every command also runs headless for scripts and agents.

The CLI documents itself:

```bash
wonderpress                  # command map
wonderpress partial help     # authoring model
wonderpress init help        # environment backends and flags
```

---

## Requirements

| Tool | Notes |
| --- | --- |
| Node.js `>= 24` | Native install for the machine architecture (avoid Rosetta Node on Apple Silicon). |
| WP-CLI (`wp`) | On `PATH`. |
| PHP and Composer | On `PATH`. Used at init and by `wonderpress lint`. |
| MySQL **or** Docker | `host` backend needs a running MySQL. `wp-env` needs Docker Desktop. |

`wp-env` replaces local MySQL, not the PHP toolchain. Both backends still need `wp`, `php`, and `composer`.

---

## Installation

```bash
npm install -g @wndrfl/wonderpress-cli
wonderpress version
```

Package: [`@wndrfl/wonderpress-cli`](https://www.npmjs.com/package/@wndrfl/wonderpress-cli)

---

## Quick start

Installing the CLI is not the same as knowing the order of work. **[docs/getting-started.md](docs/getting-started.md)** is the narrative: build the environment, set the block namespace, wire design tokens, then author partials.

```bash
wonderpress init --dir ~/projects/acme --env wp-env --namespace acme --theme acme --yes
```

`--namespace` is written into page content as `<namespace>/<slug>`. Change it later and existing blocks become unrecognized. Pin it to the client name at init; it is recorded in `.wonderpressrc` and does not drift.

On `wp-env`, the site is serving when init finishes. On `host`, start it with `wonderpress server`.

---

## Command reference

Global options used across many commands:

| Flag | Description |
| --- | --- |
| `--dir <path>` | Environment root (default: current directory, or the detected project root). |
| `--theme <name>` | Target a theme by slug instead of the active lookup. |
| `--env <backend>` | `host` (default) or `wp-env`. Needed at `init`; later commands read `.wonderpressrc`. Override per invocation with `WONDERPRESS_ENV`. |
| `--format json` | Structured `{ ok, data, error }` envelope. Unknown values are refused. |
| `-h`, `--help` | Help for the current command (same as `wonderpress <command> help`). |

Exit codes: **`0`** success, **`1`** failure, **`2`** usage (ambiguous theme, bad flags, and similar).

### Environment

#### `wonderpress init`

Clones the [development environment](https://github.com/wndrfl/wonderpress-development-environment), downloads WordPress, creates the database, installs theme Composer dependencies (including `wonderpress-core`) and [Static Kit](https://github.com/wndrfl/static-kit), and activates the theme.

| Flag | Description |
| --- | --- |
| `--yes`, `-y` | Headless: take defaults, never prompt. |
| `--env <host\|wp-env>` | Backend. Recorded in `.wonderpressrc`. |
| `--dir <path>` | Where to build (default: cwd). |
| `--theme <name>` | Theme to activate (default: `wonderpress`). |
| `--namespace <slug>` | Block namespace. Defaults to the theme slug. Set once. |
| `--db-host`, `--db-user`, `--db-name`, `--db-password` | Database. Host backend only. Password may come from `WP_DB_PASSWORD`. |
| `--wp-url <url>` | Site URL. Host backend only. |
| `--wp-title <title>` | Site title. |
| `--admin-user`, `--admin-email`, `--admin-password` | First administrator. Password may come from `WP_ADMIN_PASSWORD`. `--admin-user` is refused on `wp-env` (the first user is always `admin`). |
| `--skip-readme` | Do not generate a project README. |

```bash
wonderpress init --yes --db-user root --db-name my_site \
  --wp-url localhost:8080 --wp-title "My Site" \
  --admin-user admin --admin-email me@example.com

wonderpress init --env wp-env --yes --wp-title "My Site"
```

The `wp-env` backend cannot honor `--db-*` or `--wp-url`. Drop those flags, or use `host`.

#### `wonderpress server` / `wonderpress server stop`

Start or stop the local site for the backend this project was built with. Bare `wonderpress server` means start. On `host`, start blocks in the foreground until Ctrl-C.

#### `wonderpress destroy`

Tear the environment down (database / containers) while keeping the theme and project files.

#### `wonderpress lint [-f, --fix]`

Runs PHPCS against the [Wonderpress coding standards](https://github.com/wndrfl/wonderpress-development-environment/blob/master/phpcs.xml) **and** `partial check-drift`. `--fix` runs `phpcbf` on lightweight PHPCS issues; it does not repair drift — use `wonderpress partial sync` for that.

`--axe` and `--budget` are reserved and currently skipped.

#### `wonderpress acf install [--free]`

Downloads and activates ACF directly from its official distribution. ACF PRO is
the default because WonderPress repeater fields require it:

```bash
ACF_PRO_LICENSE=... wonderpress acf install
```

The key is read only from the environment; it is not accepted as an argument,
written to the project, or passed to WP-CLI. Use `--free` to install the latest
free edition from `https://www.advancedcustomfields.com/latest/`. Add `--force`
to download and reinstall an edition that is already present.

This installs and activates the plugin but does not persist the PRO license for
updates. Configure `ACF_PRO_LICENSE` in `wp-config.php` or activate it in the
ACF admin.

#### `wonderpress version`

Print the installed CLI version.

---

### Authoring

A **partial** is a rendering primitive (button, section, quote). It is not a Gutenberg block. A **block** is definitionally a wrapper over a partial: it cannot exist without one. A partial does not need a block.

#### `wonderpress partial create`

Scaffolds a PHP class, view template, agent-readable manifest, and a delegated Static Kit style stub.

| Flag | Description |
| --- | --- |
| `--name <Class_Name>` | PHP class name. Positional name works too (`partial create Hero`). Omit both for the wizard. |
| `--json <@file\|string>` | Create from a JSON spec instead of flags. |
| `--prop <name:type[:required]>` | Property (repeatable). Types: `string`, `boolean`, `image`, `link`, `repeater`, `array`, `object`. |
| `--sub <parent:name:type[:required]>` | Repeater sub-field (repeatable). |
| `--acf` | Mark ACF-compatible. Core registers a field group from the manifest when ACF is present. Cannot combine with `--no-manifest`. |
| `--block` | Also emit a Gutenberg wrapper (`block.json` + a `render.php` that delegates to the partial). |
| `--js` | Also scaffold a JS behavior class (delegated to Static Kit). Most partials have no behavior. |
| `--template-name <name.php>` | View template filename. |
| `--no-template` | Skip the view. |
| `--no-style` | Skip the SCSS stub. |
| `--no-manifest` | Skip the manifest. Cannot combine with `--block` or `--acf`. |

`--block --no-manifest` and `--acf --no-manifest` are refused. `--js --no-template` emits no behavior class. `--block` and `--acf` may be combined: the block uses Gutenberg attributes; the PHP caller uses ACF. Do not locate the ACF group on a page that also inserts the block.

```bash
wonderpress partial create --name Testimonial --prop quote:string:required
wonderpress partial create --name Hero --block --js
wonderpress partial create --name Testimonials --acf \
  --prop items:repeater --sub items:quote:string:required
```

#### `wonderpress partial list`

List every partial (name, slug, wrapping block if any). Indexed from `.wonderpress/manifest/partials/*.json`.

#### `wonderpress partial sync [<Name>]`

Regenerate class `$_properties` and `block.json` from the manifest after editing properties in JSON.

| Flag | Description |
| --- | --- |
| `--all` | Sync every partial in the theme. |
| `--slug <slug>` | Address by slug instead of class name. |
| `--dry-run` | Print what would be written. |
| `--properties-only` | Update class + `block.json` only (skip `render.php`). |

#### `wonderpress partial check-drift [<Name>]`

Fail if class or `block.json` has drifted from the manifest. Use in CI; repair with `partial sync`. Supports `--all` and `--format json`.

#### `wonderpress partial add-js [<Name>]`

Scaffold a JS behavior class onto an existing partial that already has a view and no script. With no name, pick from eligible partials. The file is not auto-imported; wire it from the page JS entry that renders the partial.

#### `wonderpress partial remove [<Name>]`

Remove a partial and every artifact its manifest records (class, view, style, behavior), then the manifest. Accepts a class name (`Call_To_Action`) or slug (`call-to-action`).

If a block wraps the partial, removal is refused — run `wonderpress block remove` first, or pass `--with-block`.

#### `wonderpress partial install-manifest <slug>`

Copy a core primitive manifest (for example `link`) into `.wonderpress/manifest/partials/`.

#### `wonderpress block create [<Name>]`

Add a Gutenberg wrapper to an existing partial. Output matches `partial create --block`. If no partial exists, create it with `--block` rather than scaffolding an empty one. With no name, pick from partials that do not yet have a block.

#### `wonderpress block list` / `wonderpress block remove [<Name>]`

List blocks and the partials behind them. Remove deletes the block directory and strips it from the manifest; the partial is left intact.

Blocks register under the Wonderpress editor category via `wonderpress-core`. If a new block is missing, run `composer install` in the theme directory.

#### `wonderpress template create`

Create a custom page template, a matching `.wonderpress/manifest/page-templates/*.json` (`schemaVersion` 1), and Static Kit page assets. `--section` rows become real PHP `render()` calls. After create, keep going in that PHP file and the manifest together (see `AGENTS.md`).

| Flag | Description |
| --- | --- |
| `--name <Name>` | Template name (e.g. `Landing` → `template-landing.php`). |
| `--lock <all\|insert\|false>` | Editor lock. |
| `--section <id:partial>` | Composition row, repeatable (e.g. `hero-main:landing-hero`). |

#### `wonderpress template list` / `wonderpress template remove [<Name>]`

List templates under `.wonderpress/manifest/page-templates/`. Remove deletes the PHP file, manifest, and delegated Static Kit JS/SCSS (pass `--no-static` to keep static files).

---

### Agents and MCP

#### `wonderpress agents write`

Writes `AGENTS.md` at the environment root (conventions plus live manifests), a one-line `CLAUDE.md` that points at it, and MCP host configs:

- `.mcp.json`
- `.cursor/mcp.json`
- `.vscode/mcp.json`
- `.codex/config.toml`

Regenerated after `init`, `partial create` / `sync`, and `template create`. Do not hand-edit the generated `AGENTS.md` index.

MCP configs pin this machine’s Node binary and CLI path, so they are **gitignored** (`agents write` adds the ignore rules). `AGENTS.md` and `CLAUDE.md` are committed.

An existing `wonderpress` MCP entry is left alone so hosts do not re-prompt for approval. Pass `--force` after switching Node versions or moving the checkout. The first write of a host config prints how to enable it.

#### `wonderpress mcp`

Starts an MCP stdio server in this package. Tools call the same operations as the CLI (`partial_list`, `partial_create`, `partial_sync`, `lint_theme`, and so on). `init`, `destroy`, `server`, and `acf install` are not tools. See `wonderpress mcp help`.

#### `wonderpress readme create`

Wizard (or flags) to generate a project README.

| Flag | Description |
| --- | --- |
| `--project-name`, `--project-description` | Identity. |
| `--github-url`, `--production-url`, `--stage-url`, `--dev-url` | Links. |

---

## Machine-readable output

`--format json` prints an envelope suitable for scripts and MCP:

```json
{ "ok": true, "data": {}, "error": null }
```

Supported on `version`, `lint`, `acf install`, `partial list`, `partial check-drift`, `partial sync --dry-run`, and `agents write`. Human output remains the default.

---

## Architecture

Wonderpress consumes [Static Kit](https://github.com/wndrfl/static-kit) as a dependency and delegates everything under the theme’s `static/` directory to it. Static Kit’s `node_modules` is installed by the CLI and is never committed. The theme’s Composer `vendor/` **is** committed: it is runtime PHP the site cannot serve without.

The ownership contract — CLI, Static Kit, and `wonderpress-core` — is in **[ARCHITECTURE.md](ARCHITECTURE.md)**.

---

## Further reading

| Document | Purpose |
| --- | --- |
| [docs/getting-started.md](docs/getting-started.md) | Order of work and irreversible decisions |
| [docs/manifest-first-partials.md](docs/manifest-first-partials.md) | Why manifests own generated PHP and `block.json` |
| [docs/property-value-shapes.md](docs/property-value-shapes.md) | Property types and values |
| [docs/static-kit-conventions.md](docs/static-kit-conventions.md) | Tokens, SCSS, and `theme.json` |

Issues: [github.com/wndrfl/wonderpress-cli](https://github.com/wndrfl/wonderpress-cli/issues)

---

## License

MIT © [Wonderful](https://wonderful.io) — see [LICENSE](LICENSE).
