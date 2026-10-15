# Architecture

## Wonderpress ↔ Static Kit

Wonderpress and [Static Kit](https://github.com/wndrfl/static-kit) are separate
projects with a deliberate boundary. This document is the contract: it states
who owns what, so the seam stays clean as both projects evolve.

### Static Kit is a dependency, never vendored

The CLI declares `@wndrfl/static-kit-cli` as a normal dependency in
[`package.json`](package.json). It is consumed two ways:

- **Programmatically** — `wonderpress init` calls `staticCli.core.installKit()`
  through `installStaticKit()` ([`src/static-kit.js`](src/static-kit.js)), which
  copies the Static Kit framework into the theme's `static/` directory and runs
  `npm install` there.
- **By delegation** — `template create` and `partial create` call into Static
  Kit (see below) rather than reaching into `static/` themselves.

Because dependencies are installed by Static Kit at setup time, **Static Kit's
`node_modules` is never committed to a Wonderpress site.** Only hand-written
source (`static/src`) and compiled output (`static/dist`) are tracked. This is
enforced by the `node_modules` rule in the shipped
[wonderpress-development-environment](https://github.com/wndrfl/wonderpress-development-environment)
`.gitignore`, and guarded by `tests/static-kit-contract.test.js`.

> Do not "fix" a missing `static/node_modules` by committing it. Run the CLI
> (or `npm install` inside `static/`) — that is the supported install path.

### Ownership boundary

| Concern | Owner | Where it lives |
| --- | --- | --- |
| PHP partials & templates (the render layer) | **Wonderpress CLI** | `wp-content/themes/wonderpress/partials`, `.../src` |
| Partial manifests (always emitted) | **Wonderpress CLI** | `.../.wonderpress/manifest/partials/*.json` |
| `block.json` + `render.php` (opt-in Gutenberg wrapper — `--block`) | **Wonderpress CLI** | `.../blocks/<slug>/` |
| The `static/` tree (layout, `.staticrc`) | **Static Kit** | `wp-content/themes/wonderpress/static` |
| Component **style stubs** (token-only SCSS) | **Static Kit** | `static/` (created via delegation) |
| Component **behavior classes** (opt-in JS — `--js`) | **Static Kit** | `static/` (created via delegation) |
| `src/` → `dist/` asset compilation | **Static Kit** | `static/src`, `static/dist` |
| Block registration, partial base classes, `wonder_*` helpers | **wonderpress-core** | `wp-content/themes/wonderpress/vendor/wndrfl/wonderpress-core` |
| Static Kit asset convention (`static/dist/{css,js}/{body_id}`) | **wonderpress-core** | `.../vendor/.../inc/assets.php` |
| Baseline theme supports (html5, align-wide, title-tag…) | **wonderpress-core** | `.../vendor/.../inc/setup.php` |
| Menu locations, image sizes, text domain, `style.css` | **Theme** | `.../themes/wonderpress/inc/setup.php`, `style.css` |

### wonderpress-core is a dependency of the theme

Core supplies the runtime the CLI's output is written against: `Abstract_Partial`,
the `wonder_*` helpers, and the `init` pass that calls `register_block_type()` on
every `block.json` the CLI emitted. The CLI writes the block; core registers it.

It is a **Composer dependency of the theme**, declared in the theme's own
`composer.json` and installed to `wp-content/themes/<theme>/vendor`. It was an
mu-plugin until 2.0.0. Two things moved it:

- **Nothing in it needs mu-plugin load order.** Its earliest hook is `init`.
  mu-plugins bought "a client cannot deactivate it," not a hook window.
- **It cannot function without a theme.** It registers the blocks in
  `get_stylesheet_directory()/blocks` and resolves its partial views through
  `locate_template()`. A dependency that cannot run without its dependent
  belongs inside it.

Unlike Static Kit's `node_modules`, **the theme's `vendor/` and `composer.lock`
ARE committed.** The two cases differ in what they carry: `node_modules` is a
build-time toolchain that never ships, while `vendor/` holds runtime PHP the site
cannot serve a page without. Committing it keeps a deploy a file copy — no
Composer on the server — while `composer update` stays the upgrade lever. The
`.gitignore` in wonderpress-development-environment carries a negation for the
theme's lock file, because the root `composer.lock` rule is unanchored and would
otherwise swallow it.

#### What belongs in the package

The test is whether a project edits it. Plumbing that shipped identically in
every project — the Static Kit bundle convention, the baseline theme supports —
is in the package, so changing the convention is a `composer update` rather than
an edit to every site that ever shipped. A bundler migration is exactly that
case.

Design surface stays in the theme: templates, `theme.json`, the partial view
files, and the per-project decisions inside `inc/setup.php` (navigation
locations, image sizes, text domain). `style.css` is the WordPress theme
identity file (headers); it is not a stylesheet.

Core keeps `theme.json` authoritative by replacing the user origin on
`wp_theme_json_data_user`; otherwise a `wp_global_styles` database record can
outrank the file without producing a diff. A project intentionally using
database-backed Global Styles opts out through
`wonderpress_strip_user_global_styles`.

**Anything moved into the package ships with the filter that lets a project opt
out.** `wonderpress_asset_candidates` replaces the bundle paths,
`wonderpress_theme_supports` declines or adds a support,
`wonderpress_disable_emojis` and `wonderpress_dequeue_block_css` toggle their
behaviours. Without the filter, moving something in trades upgradability for
the ability to change it at all, which is not a trade worth making.

`style.css` is WordPress metadata (the `Theme Name:` header). It is not
enqueued. Front-end CSS is the Static Kit bundle, including the
`.screen-reader-text` hide/focus rules in `lib/_utilities.scss`.

The version constraint lives in the theme's `composer.json` and nowhere else.
The CLI names the package (`core.CORE_PACKAGE`) and deliberately does not
restate a version, so the two cannot drift; `tests/init-orchestration.test.js`
guards that.

### A partial is not a block

A **partial** is a Wonderpress rendering primitive — a button, a section, a
link. It turns properties into HTML (`Abstract_Partial`), is often composed
inside other partials, and has no inherent relationship to the editor.

A **block** is a formal WordPress notion: `block.json` plus
`register_block_type()` is what surfaces something in the Gutenberg inserter.
Its whole reason to exist is editor availability.

The two are orthogonal, so the spine treats them that way. The partial and its
manifest entry are the always-on output; the block is an **opt-in editor
wrapper** (`--block`) whose `render.php` delegates straight back to the partial.
"A block is a partial I also chose to expose in Gutenberg" — never the reverse.
Emitting `block.json` for every low-level partial would hand editor-registration
metadata to things that have no business carrying it.

Blocks are dynamic and server-rendered: `render.php` news up the partial class
and echoes `->render()`. The PHP partial is the only source of HTML. Editor
presence is one buildless script in wonderpress-core
(`assets/js/editor-preview.js`): it calls `registerBlockType()` with an `edit`
that draws Inspector Controls from the manifest schema and previews via
`ServerSideRender`. Generated `block.json` has no `editorScript`. There is no
per-block JSX and no editor bundler. See
[docs/editor-js-plan.md](docs/editor-js-plan.md).

### The manifest tree

All Wonderpress manifests live under `.wonderpress/manifest/`, typed by path:
`partials/` for components, `page-templates/` for page-template contracts.
Each file points at a JSON Schema in `schema/` via `$schema`. Those schema
files are generated from the same constants the CLI validates with
(`src/manifest-schema.js`), so editor completion matches the validator.

### Partial manifests are the index

`.wonderpress/manifest/partials/<slug>.json` is the CLI's record of what a component is
and what was written for it. `partial list`, `partial remove`, `block create`,
`block list`, and `block remove` all read it rather than scanning (and guessing
at) source files — so the manifest is authoritative, and the deletion list for a
removal is exactly what creation recorded.

wonderpress-core reads manifests at runtime in `inc/manifests.php`
(`wonder_load_theme_manifests()`). ACF is one consumer: `inc/acf.php` registers
a field group on `acf/init` for every `acf_compatible` manifest that is located
via template composition and/or `wonderpress_template_fields`. That is parallel
to how core registers `blocks/<slug>/block.json`. The CLI still owns the files;
core never writes them. Partial manifests declare fields only; page-template
manifests and the theme filter declare placement.

**Dual-authorable types:** When a partial is both ACF-compatible and exposed as
a block, every property type must be authorable in ACF and in the block editor
with the same value shape. Tier A (scalars) and Tier A+ (`image`, `link`,
`post_object`, `repeater`, `partial` embeds) are enforced by the CLI and
normalized on the block path by `wonder_normalize_property_value()`. See
[docs/dual-authorable-types.md](docs/dual-authorable-types.md) and
[docs/property-value-shapes.md](docs/property-value-shapes.md).

**Page-template manifests** (`.wonderpress/manifest/page-templates/<template>.json`, integer
`schemaVersion`) declare the editor contract (`editor.lock`, `editor.native`) and
an ordered `composition`: partial instances (`id` + `partial`), inline field
groups (`id` + `properties[]`, no render), and optional tab rows (`id`, `label`,
`items[]`) that group instances as ACF tabs (root instances have no tab wrapper).
Core merges locks with
`wonderpress_template_locks`, registers one ACF group per template when
composition lists ACF-compatible partials (field names = instance ids), and
exposes `wonder_render_template_sections()` for all-partial pages. Scaffolded
PHP and AGENTS.md use explicit `wonder_partial_props()` / HTML instead. Partial
manifests stay the
component dictionary; template manifests are the page-template sentence.

```json
{
  "name": "Call_To_Action",
  "slug": "call-to-action",
  "block": "wonderpress/call-to-action",
  "acf_compatible": false,
  "properties": [{ "name": "body", "type": "string", "required": true, "description": "" }],
  "artifacts": {
    "class": "src/partials/class-call-to-action.php",
    "view": "partials/call-to-action.php",
    "block": "blocks/call-to-action/block.json",
    "render": "blocks/call-to-action/render.php",
    "style": "static/src/scss/components/_call-to-action.scss",
    "script": "static/src/js/components/CallToAction.js"
  }
}
```

`block`, `artifacts.block`, `artifacts.render` appear only with `--block`;
`artifacts.script` only with `--js`; and the two delegated artifacts (`style`,
`script`) are recorded **only when Static Kit actually wrote them** — the
manifest never advertises a file that does not exist.

### Delegate, don't scaffold

The CLI never writes into `static/` directly. When a command needs something to
exist under `static/`, it calls the Static Kit CLI, which owns the location and
format:

- `template create` → `staticCli.template.create()`
  ([`src/template.js`](src/template.js))
- `partial create` (style half, plus the opt-in `--js` behavior half) →
  `staticCli.component.create()` ([`src/partial.js`](src/partial.js))
- `partial remove` → `staticCli.component.remove()`
- `static compile` → `staticCli.compile.all()` with the theme `static/` as
  `--dir` ([`src/static.js`](src/static.js)). Watch is CLI-only (not MCP).

This keeps a single source of truth for anything under `static/`: if the Static
Kit layout changes, Wonderpress inherits it for free instead of drifting.

`partial create` records the paths `component.create` returns. `partial remove`
calls `component.remove`, then deletes the `style` and `script` paths the
manifest recorded — so a 3.0-era `lib/partials` tree is not orphaned when the
installed kit only knows about `components/`. `installKit` keys off a config
file and merges into a seeded directory, so this CLI does not park files aside
or write into `static/` itself.

### Versioning

The `@wndrfl/static-kit-cli` version range in [`package.json`](package.json) is
the single point of coordination between the two projects. A caret range is
intentional — these are first-party packages released in lockstep. Pin an exact
version only if you need to freeze against a specific Static Kit layout.

## Fence contract

A generated partial class has two owners, separated by marker lines:

```php
class Hero extends Abstract_Partial {

	// <wonderpress:generated>
	protected $acf_compatible = true;          // when acf_compatible
	protected $partial_template = './partials/hero.php';
	protected static $properties = array( /* … from the manifest … */ );
	// </wonderpress:generated>

	public function variant_class() {          // yours: survives every sync
		return 'hero--wide';
	}
}
```

- **Inside the fence is machine-owned.** `partial sync` rewrites the region
  between `// <wonderpress:generated>` and `// </wonderpress:generated>` from
  the manifest every time. Editing it is drift; edit the manifest and re-sync.
- **Everything outside the fence is the user's, byte for byte** — the header
  docblock, `namespace`/`use` lines, the class declaration, and any methods,
  constants, or overrides added inside the class below the closing marker. That
  is the sanctioned home for custom PHP on a partial. Sync splices only the
  region; a CRLF file keeps CRLF, including in the regenerated region.
- **block.json stays wholly machine-owned** (no fences).

One renderer ([`src/partial-class.js`](src/partial-class.js)) serves both the
writer (`writePartialClass` in [`src/partial.js`](src/partial.js)) and drift
([`src/partial-drift.js`](src/partial-drift.js)), so they can never disagree
about what sync would write. The class path comes from `manifest.artifacts.class`
(falling back to `src/partials/class-<slug>.php`). Every writer that rewrites
the manifest (`partial create`, `partial sync`, `block create`, `partial add-js`)
keeps a recorded path (`recordedClassRelPath`), so none re-points the class at
the default location and leaves a duplicate class beside the user's file.

What a class write does to an existing file:

| On disk | `partial sync` | `--force` |
|---|---|---|
| no file | write the full fenced render | same |
| fenced file | replace only the fenced region | same (force only overrides a conflict; see Sync lock) |
| unfenced, pristine legacy output | rewrite with fences, silently | same |
| unfenced, hand-edited | **refuse** (`class_unfenced`), nothing written | rewrite the whole file |
| malformed markers | **refuse** (`class_fence`), nothing written | rewrite the whole file |

"Pristine legacy" means the file is exactly what the pre-fence template
(`src/templates/partial.class.legacy.mustache`, frozen) produced for *some*
properties: the generated values are read back out of the file and re-rendered,
so a file synced from an older manifest still migrates, while any hand-written
line fails the comparison. Refusals happen before block.json or the manifest is
touched, and `--format json` reports them as `error.code` `class_unfenced` /
`class_fence` with a `--force` hint (MCP `partial_sync` mirrors this and takes
`force: true`). `partial sync --dry-run` reports each plan's `classAction`
(`create | update | unchanged | migrate | force | refuse`).

Drift (`partial check-drift`, `lint`): a fenced class is compared region to
region, so edits outside the fence are never drift; an unfenced legacy class
keeps the whole-file comparison against the legacy render. Malformed markers
report `class_drift`. Checksums and the `clean | pending | conflict` states
build on this contract separately.

## Sync lock and drift states

`partial sync` (and `partial create`, which is a partial's first sync) records
what it wrote in a per-partial lock, committed with the theme:

```
.wonderpress/lock/partials/<slug>.json
{
  "manifest":   "<sha256 of the manifest file as sync left it>",
  "classFence": "<sha256 of the class's fenced region as written>",
  "block":      "<sha256 of block.json as written>",   // only when the partial is a block
  "cliVersion": "<CLI version that wrote the lock>"
}
```

- **One file per partial, outside the manifest.** Two branches that touch
  different partials never conflict on a lock, and the hand-edited manifest does
  not churn when a hash moves. Commit the lock directory; it is the "last sync"
  leg of the three-way comparison, and a teammate without it sees `pending`.
- **Hashes are of exact content**, with one exception: CRLF counts as LF, so a
  Windows autocrlf checkout of committed files is not mistaken for a hand edit.
  The class hash covers only the fenced region (markers included) as
  `extractFencedRegion()` returns it; everything outside the fence may change
  freely. Code: [`src/partial-lock.js`](src/partial-lock.js).
- The lock is written last, after every artifact is on disk. `partial remove`
  deletes it. `block create` and `add-js` rewrite the manifest without writing a
  lock, so the partial reads `pending` until the next sync.

`checkPartialDrift()` ([`src/partial-drift.js`](src/partial-drift.js)) compares
disk, manifest, and lock, and reports one state per partial with the changes
behind it:

| State | Meaning | Sync |
|---|---|---|
| `clean` | manifest, generated files, and lock agree | nothing to do |
| `pending` | the manifest changed since the last sync, a generated file is missing or unrecorded, the generator changed (`stale`), or there is no lock yet | safe; applies it |
| `conflict` | the class's fenced region or block.json changed since the last sync (hand edit inside machine-owned output) | **refused** unless `--force` |

Conflict wins when both apply. A partial with **no lock** (legacy, or created by
an older CLI) is always `pending`, never `clean`, and its change carries the
binary comparison ("generated files match / differ from the manifest"); the
first sync writes the lock. A legacy unfenced class that is still pristine
generator output is `pending` (`legacy`): sync migrates it. Each change is
`{ artifact: manifest | class | block, region: fence | file | null, kind, state, message }`;
kinds are `edited`, `missing`, `unrecorded`, `stale`, `unfenced`, `malformed`,
`legacy`, `no_lock`, `lock_invalid`, `invalid`.

Where it surfaces:

- `partial check-drift --format json` → `data.partials[]` of
  `{ slug, state, changes }` (plus the older `data.results[]`, which keeps the
  binary `ok`/`issues`). MCP `partial_check_drift` returns the same `partials`.
  Human output is silent for clean partials and one line for every other.
- **Exit codes and `ok`.** A partial is not `ok` (exit 1, `error.code` `drift`,
  or `conflict` when any partial is in conflict) when it is in conflict or its
  generated files no longer match the manifest, which is when drift has always
  failed. A pending partial whose files still match (no lock yet, a reformatted
  manifest) is reported but passes, so upgrading the CLI does not fail CI on
  every lock-less partial.
- `lint` uses the same split: conflict and out-of-step pending are errors
  (fail lint); pending with matching files is a warning. `data.drift` gains
  `states` (counts) and `partials`.
- `partial sync <Name>` refuses a partial in conflict before writing anything
  (`error.code` `conflict`, naming the partial and artifact/region; the hint
  says resolve in the IDE or use `--force`). A class that lost its markers or
  has broken ones since the last sync (`unfenced`, `malformed`) is a conflict
  too, refused with code `conflict` and the class writer's recovery advice
  appended. Without a lock, the writer's own refusals stand (`class_unfenced`,
  `class_fence`). `sync --dry-run` plans carry `state`, `changes`, and
  `blocked`. `sync --all` (and MCP `partial_sync` with `all`) skips every
  refused partial (conflicts and lock-less fence refusals) with a warning and
  reports it in `data.skipped[]` (`{ slug, code, ... }`) rather than aborting
  the run.
- **Every writer of generated output honours a conflict, not just sync.**
  Re-running `partial create` for an existing partial regenerates its class
  region and block.json and re-records the lock, and `block create` on a
  partial that is already a block regenerates block.json; either would erase a
  hand edit and leave the partial reading `clean`. Both refuse a conflict the
  same way (code `conflict`, hint naming their own `--force`); `block create`
  only checks block.json, the one file it rewrites. MCP `partial_create` and
  `block_create` take `force` for the same override. The shared check is
  `assertNoConflict()` in [`src/partial.js`](src/partial.js).
- **`--force` overrides refusals; it does not widen the write.** Forcing past a
  conflict on an intact fence still replaces only the region and keeps every
  byte outside it. Only a class with no or malformed markers is rewritten
  whole.

## App-facing commands and the version pin

The desktop app drives the CLI through `wonderpress mcp` and through one-shot
commands run with `--format json`, reading exactly one `{ ok, data, error }`
envelope off stdout. These commands exist so that contract covers the
environment lifecycle, prerequisites, and the manifest schema, and so a project
can say which CLI it was built with.

### `server` in JSON

`server start|stop|status --format json` all return
`data: { backend, detached, running, url, adminUrl, port, pid }`.

- **status** asks the backend. wp-env answers with `wp-env status --json`
  (Docker's own view, including the real port); when that command is missing
  (it arrived after 11.12) or there is no wp-env binary, the configured port is
  probed — and a probe can only prove a negative. Nothing answering is
  `running: false`; something answering is `running: null`, because it is as
  likely another project's wp-env (the usual 8888 conflict) as this one. The host's `wp server` is someone else's foreground job, so status
  connects to its port from Node ([`src/env/probe.js`](src/env/probe.js)). Never
  `lsof`/`netstat`: they do not exist on Windows.
- **start** on wp-env prints the envelope after `wp-env start` returns. On the
  host, `wp server` blocks, so JSON mode spawns it with its stdout and stderr
  wired to the CLI's stderr, waits until the port answers, prints the envelope
  (with the child's `pid`), and keeps serving. stdout carries the envelope and
  nothing else; a server that dies before it is ready is an `ok: false`
  envelope instead. Human mode is unchanged (`execSync('wp server')`).
  `wp server` is WP-CLI running `php -S` as its own child, and the grandchild
  holds the port, so JSON mode spawns it as the leader of a new process group
  (POSIX), forwards SIGINT/SIGTERM/SIGHUP to the group, and sweeps the group
  whenever the leader exits — signalling only the CLI or only the `wp` pid used
  to orphan a still-listening `php -S`. The reported `pid` is the group id. A
  server that ends after the envelope went out exits the CLI 0 if it was asked
  to stop (a forwarded signal, or a stop signal sent to it directly) and 1,
  with a line on stderr, if it crashed — the exit code is the only channel a
  supervisor has left by then.
- **stop** on the host cannot stop anything — it reports the probed state
  rather than claiming success, with a note on stderr.
- An unknown subcommand is an error. It used to fall through to start.

### `doctor`

[`src/doctor.js`](src/doctor.js) owns every prerequisite check; each backend's
`preflight()` is `doctor.preflight(<backend>)`, and `init` still calls
`backend.preflight()`, so a failed init and `wonderpress doctor` report the
same things in the same words (a check's `hint` is the message init has always
printed). A check is `{ check, label, ok, backend, platform, hint, detail }`;
`backend`/`platform` say where it applies. Scope: `--env`/`WONDERPRESS_ENV`,
else the project's backend, else every backend. The wp-env port check is
doctor-only (preflight runs before `.wp-env.json` exists; provision checks the
port itself with the same message) and passes when the port is held by the
project's own running environment — confirmed by wp-env, not inferred from
something answering on the port. Composer is checked for both backends (it
installs the theme's packages on the host either way); before it was, a
missing Composer surfaced mid-init, after the clone and npm install. On Windows the host backend is a single
failing `host-platform` check pointing at wp-env, and every-backend mode skips
the host there. `init`'s preflight treats that one check as a warning instead
(see "Cross-platform support"). The wp-env port hint names the platform's own
tool (`portOwnerCommand` in [`src/proc.js`](src/proc.js)).

### `manifest schema`

`manifest schema [partial|template]` prints `buildPartialManifestSchema()` /
`buildPageTemplateManifestSchema()` from
[`src/manifest-schema.js`](src/manifest-schema.js) — both as
`{ partial, template }` when no kind is given. Consumers validate against the
schema of the CLI version the project pins instead of carrying a copy.

### The `cliVersion` pin

`init` writes `"cliVersion": "<running version>"` into `.wonderpressrc` when the
project has no pin yet; an existing pin is never bumped silently. `cli.js`
resolves the project root once before dispatch and, when the pin differs from
the running version, writes one warning to **stderr** — in every mode, since
stdout belongs to the JSON envelope or the MCP protocol. No pin, or no project,
means no warning. `version --format json` carries
`cliVersionMismatch: { pinned, current } | null`.

### Running on Electron's Node

The desktop app runs the CLI on Electron's bundled Node (`ELECTRON_RUN_AS_NODE=1`),
not a system `node`. shelljs checks `process.versions.electron` at load and,
when it is set, leaves `config.execPath` null, so any synchronous `sh.exec()`
returns `undefined` instead of a result. Since the cross-platform work below
no command runs through `sh.exec` any more (everything goes through
[`src/proc.js`](src/proc.js), a plain `spawnSync`), and the `sh.which` calls
that remain do not need `execPath`. Even so, the CLI must not be one stray
`sh.exec` away from breaking in the app, so
[`src/shell-exec-path.js`](src/shell-exec-path.js) sets
`sh.config.execPath = process.execPath` whenever it is null or Electron is
detected — under `ELECTRON_RUN_AS_NODE` that path *is* a working node. It is
the first import of `bin/wonderpress.js` and `src/cli.js`. On plain Node
shelljs has already set the same value, so the module is a no-op there; the
CLI takes no Electron dependency and has no Electron-only path.
[`tests/electron-execpath.test.js`](tests/electron-execpath.test.js) fakes the
Electron signal with a `node -r` preload and pins that `version` and `doctor`
still answer in JSON.

## Cross-platform support

The CLI is the gate for the desktop app's platforms (app spec section 3): the
app's Windows and Linux builds ship only while the `unit` job in
[`.github/workflows/test.yml`](.github/workflows/test.yml) is green on
`ubuntu-latest`, `macos-latest` and `windows-latest`. Integration and e2e stay
Ubuntu-only — they need MySQL, PHP, WP-CLI and Docker services.

### Tiers

| Platform | Backends | Notes |
| --- | --- | --- |
| macOS | host, wp-env | Reference platform. |
| Linux (Ubuntu LTS tested) | host, wp-env | |
| Windows 10/11 | wp-env | Docker Desktop with the WSL2 engine. Host: unsupported. |

**Why the host backend is unsupported on Windows.** It means native PHP, MySQL
and WP-CLI (`wp.bat`) on the PATH and `wp server` (PHP's built-in server) as a
supervised foreground process. None of that is tested on Windows, `wp server`'s
`php -S` grandchild cannot be stopped as a group (there are no process groups;
the JSON-mode start falls back to `taskkill /T /F` by pid), and the e2e that
proves the host lifecycle runs on Ubuntu only. The decision, by layer:

- `wonderpress doctor` reports it as one failing `host-platform` check — a
  checklist that can never fully pass is worse than one sentence.
- `init`'s preflight (`doctor.preflight('host')` on win32) turns that check
  into a **warning** (`HINTS.hostOnWindowsInit`: "it may work, but nothing tests
  it there") and still checks WP-CLI and Composer, so a determined user can
  try. The CLI warns; the app blocks it in onboarding, because the app could
  not help them when it fails.

### The argv rule

A command that carries a path, a name, a password or any other user value is
run as an **argv array**, never as a string handed to a shell.
[`src/proc.js`](src/proc.js)'s `run(bin, args, opts)` is the one way to do it:
it returns shelljs's `{ code, stdout, stderr }` shape (with `toString()` →
stdout) so converted call sites read results unchanged, reports a missing
program as `code: 127` (and, unless `silent`, prints `<bin>: command not
found` to stderr, as the shell used to), never inherits stdin (MCP's protocol
channel), and while `--format json` or MCP owns stdout routes the child's
stdout to stderr. `run()` never throws, so a caller that used to rely on
`execSync` throwing must check `code` itself: the foreground `server start`
(`foregroundOutcome` in [`src/env/host.js`](src/env/host.js)) treats a signal
stop as success and anything else non-zero as a failure with exit code 1.

The string form was wrong twice over: sh and cmd.exe disagree about quoting,
`$`, `%`, `&` and spaces, so `wp core install --title="My $HOME"` meant
different things on each, and a database password with a space split in two.
`buildWpCliCommand`'s POSIX single-quoting became `buildWpCliArgv` in
[`src/env/command.js`](src/env/command.js), which returns `{ file, args }`.

Windows batch files (`wp.bat`, `composer.bat`, `phpcs.bat`, npm's
`node_modules/.bin/*.cmd`) cannot be spawned without a shell, so `buildSpawn`
builds the `cmd.exe /d /s /c "..."` line itself with every argument escaped
(cross-spawn's rules, double-escaped for npm shims) and verbatim arguments. The
caller still passes argv. `resolveBin` finds `wp` → `wp.bat` with PATHEXT on
Windows; per-platform names are explicit where the CLI picks a file itself:
`vendor/bin/phpcs.bat` / `phpcbf.bat` (`phpcsBin` in
[`src/lint.js`](src/lint.js), with a clear "run composer install" error when
missing) and `node_modules/.bin/wp-env.cmd` (`resolveWpEnvBin`).

No shell commands for filesystem work: `init --clean-slate` is
`core.cleanSlate()` — fs-extra `emptyDir`, dotfiles included, refusing the
filesystem root and the home directory — not `rm -rf <dir>/*` and `rm -rf
<dir>/.*`.

### The forward-slash rule

Paths used to touch the filesystem are built with `path.join`/`path.resolve`
and stay native. Paths written **into** a file another machine reads —
manifests, sync locks, block.json, `.wonderpressrc` — and theme-relative paths
in JSON envelopes (a manifest's `artifacts`) are always forward-slash, whatever
OS wrote them (app spec section 3: "manifests always use forward slashes").
Absolute paths describing this machine (a `wrote` entry, an MCP config's
`args`) stay native. Normalize at that boundary (`themeRel` in
`src/partial.js`, `toPosixPath` in `src/proc.js`); `tests/crud.test.js` scans a
freshly written manifest, block.json and lock for backslashes, which is a real
check on the Windows leg. Human output shortens absolute paths (POSIX and
`C:\...`) relative to the cwd and prints them with forward slashes too.

### Tests on Windows

Command stubs come from `tests/helpers/stub-bin.js`: the behavior is
JavaScript, and the launcher is a `#!/bin/sh` script or a `.bat` depending on
the OS, which is exactly what Composer and WP-CLI install. Dynamic imports in
spawned `-e` scripts use `pathToFileURL(...).href` (a bare `D:\...` is not an
ESM specifier). Tests that are inherently POSIX — process-group signalling in
`server start --format json` — are skipped on win32 with the reason, not
deleted; the readiness half of that path runs everywhere. `.gitattributes`
(`* text=auto eol=lf`) keeps a Windows checkout LF, so byte-exact fixtures
(fences, checksums) compare as they do elsewhere; the code itself already reads
CRLF as LF where it hashes (see "Sync lock and drift states").

