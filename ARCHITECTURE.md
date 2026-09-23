# Architecture

## WonderPress ↔ Static Kit

WonderPress and [Static Kit](https://github.com/wndrfl/static-kit) are separate
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
`node_modules` is never committed to a WonderPress site.** Only hand-written
source (`static/src`) and compiled output (`static/dist`) are tracked. This is
enforced by the `node_modules` rule in the shipped
[wonderpress-development-environment](https://github.com/wndrfl/wonderpress-development-environment)
`.gitignore`, and guarded by `tests/static-kit-contract.test.js`.

> Do not "fix" a missing `static/node_modules` by committing it. Run the CLI
> (or `npm install` inside `static/`) — that is the supported install path.

### Ownership boundary

| Concern | Owner | Where it lives |
| --- | --- | --- |
| PHP partials & templates (the render layer) | **WonderPress CLI** | `wp-content/themes/wonderpress/partials`, `.../src` |
| Partial manifests (always emitted) | **WonderPress CLI** | `.../.wonderpress/manifest/partials/*.json` |
| `block.json` + `render.php` (opt-in Gutenberg wrapper — `--block`) | **WonderPress CLI** | `.../blocks/<slug>/` |
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
an edit to every site that ever shipped. The Vite migration in ROADMAP Phase 0
is exactly that case.

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

A **partial** is a WonderPress rendering primitive — a button, a section, a
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

All WonderPress manifests live under `.wonderpress/manifest/`, typed by path:
`partials/` for components, `page-templates/` for page-template contracts.

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
renders via `wonder_render_template_sections()`. Partial manifests stay the
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
    "style": "static/src/scss/partials/_call-to-action.scss",
    "script": "static/src/js/lib/partials/CallToAction.js"
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

This keeps a single source of truth for anything under `static/`: if the Static
Kit layout changes, WonderPress inherits it for free instead of drifting.

#### The known asymmetry: removal

Creation is delegated; **removal currently is not**. Static Kit exposes no
`component.remove`, so `partial remove` deletes the delegated outputs (the style
stub and the JS behavior class) from `static/` directly, using the paths its
manifest recorded at creation time. This is a deliberate, documented exception
to "the CLI never writes into `static/`" — a partial you removed should not
leave its assets behind. It is slated to move behind Static Kit as soon as a
removal API exists. Relatedly, `component.create` does not report the paths it
wrote, so the CLI can only confirm Static Kit's **default** layout; under a
custom `.staticrc` src layout the delegated artifacts are recorded as not
written (and a removal warns about the file it cannot name) rather than
recording a path that may be wrong.

#### The known asymmetry: a scaffold that seeds `static/`

`installKit` reads *any* existing `static/` as proof of an installation and
returns — no framework, no `npm install`, no compile. The theme scaffold does
seed that directory (`lib/_utilities.scss`, the accessibility utilities every
page entry uses), so `init` would otherwise hand back a theme with no `dist/`
at all, and exit 0 doing it.

`installStaticKit()` ([`src/static-kit.js`](src/static-kit.js)) holds the seeded
files aside, lets Static Kit install into a clean directory, puts them back, and
only then compiles — so what the scaffold ships reaches `dist/`. It is the
second exception to "the CLI never writes into `static/`", and like the first it
belongs behind Static Kit: the fix there is for `installKit` to key off its own
`.staticrc` rather than directory existence.

### Versioning

The `@wndrfl/static-kit-cli` version range in [`package.json`](package.json) is
the single point of coordination between the two projects. A caret range is
intentional — these are first-party packages released in lockstep. Pin an exact
version only if you need to freeze against a specific Static Kit layout.
