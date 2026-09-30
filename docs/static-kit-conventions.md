# Static Kit conventions (and how the WonderPress spine interoperates)

Reference for how styles/scripts are structured in a WonderPress theme's
`static/` tree, why, and which parts the CLI owns vs. delegates. This is the
shared model the spine, the component-scaffold API, and the build-tool
modernization should all build to.

> `static/` is **installed by Static Kit** (`init` runs `staticCli.core.installKit`).
> It is Static Kit's tree. The CLI must not hardcode its internal layout —
> it delegates (see "Ownership").

## The core idea: per-page bundles (tree-shaking)

Static Kit compiles **one entry per page/template** and the theme loads **only
that page's bundle**:

- `src/scss/<page>.scss` → `dist/css/<page>.css`
- `src/js/<page>.js` → `dist/js/<page>.js`
- The theme enqueues `dist/{css,js}/<wonder_body_id()>.{css,js}` — i.e. only the
  current template's bundle.

Each entry `@use`s / imports **only the partials that page needs**. That import
list *is* the tree-shaking decision — a page ships nothing it doesn't use.

**Exception: accessibility utilities.** `lib/_utilities.scss` holds the
WordPress `.screen-reader-text` hide rules (clip-path, not `display: none`)
and the `:focus` reveal for a skip-link. Core-generated markup and the
skip-link use that class, so every page entry `@use`s `lib/utilities`. Do not
invent a second classname. Theme `style.css` is WordPress metadata only.

```
src/
├─ scss/
│  ├─ <page>.scss          ← per-page ENTRY (home.scss, single.scss, archive-*.scss …)
│  ├─ lib/                 ← kit primitives: tokens, functions, flex, type, utilities, reset
│  └─ components/          ← per-COMPONENT styles: _<slug>.scss
└─ js/
   ├─ <page>.js            ← per-page ENTRY (home.js, single.js …)
   ├─ components/          ← per-COMPONENT behavior: <Pascal>.js
   └─ lib/                 ← kit JS helpers
```

New stamps use `components/`. Older trees may still have `src/scss/partials` and
`src/js/lib/partials`; the path recorded on the partial manifest is source of
truth for `remove`.

## Namespaces communicate scope (where it lives / is used)

The prefix on a component's class is a **scope namespace**, a signal to devs:

- **`theme-<slug>`** — theme-level: reusable across pages (global). The default
  for a `partial` (an `Abstract_Partial` is reusable by construction).
- **`<page-slug>-<slug>`** — page-level: lives on / used only by that page
  (e.g. `.home-blogs` defined in `home.scss`).

A page entry composes both: theme-level partials it reuses **and** any
page-level ones specific to it.

## SCSS component

`src/scss/components/_<slug>.scss`, selector `.<slug>`, composed from kit
tokens; BEM `&--modifier` / `&__element`:

```scss
@use "../lib/tokens" as *;
.cta-banner {
  //
  &--white { background-color: $color-white; }
}
```

Opt-in per page: an entry does `@use 'components/cta-banner';` only where
needed.

## JS component + page entry

- `src/js/components/<Pascal>.js` — a `class <Pascal>` (component behavior).
- Each page entry imports the component classes that page needs and inits
  them — mirroring the SCSS entry's `@use` list. Nothing under `components/`
  is auto-wired.

## Design tokens: `theme.json` publishes, wonderpress-core bridges

A WonderPress theme has two places that know what "accent" means, and they are
owned by different projects:

- **`theme.json`** declares the palette, font families, and the type scale
  (`settings.custom.type`). This is what constrains the editor — it is the
  reason a client's colour picker offers three swatches instead of the spectrum.
- **`static/src/scss/lib/tokens/`** declares the same values as Sass
  variables, for the CSS that actually renders the site. Each assignment is
  `$id: var(--id, fallback)`.

Left alone, a project types its brand colours into both and they drift. Setting
brand colours is the first thing anyone does on a new project, so this is a day
one problem, not a someday one.

**The rule: kit CSS variables are the shared names. `theme.json` fills them. wonderpress-core prints the join.**

Static Kit 3.1 ships `$color-accent: var(--color-accent, …)` (and the same shape
for fonts and type) in `lib/tokens`. The file comments say the host sets
matching `--color-*`, `--font-*`, and `--type-*` properties on `:root`.
wonderpress-core is that host. From `theme.json` it prints:

```css
:root {
  --color-blue: var(--wp--preset--color--blue);
  --font-sans-serif: var(--wp--preset--font-family--sans-serif);
  --type-h2-size-tablet: var(--wp--custom--type--h2--size-tablet);
  --color-error: var(--wp--custom--color--error);
}
```

Palette and font-family slugs use `--wp--preset--*`. The type scale lives in
`settings.custom.type` because `fontSizes` is the editor's small / medium /
large dropdown, and WordPress has no preset slot for per-level line-height,
weight, tracking, or breakpoint variants. `sizeTablet` becomes
`--wp--custom--type--h2--size-tablet`, and the bridge collapses that to the
kit name `--type-h2-size-tablet`. Status colors that should stay out of the
color picker (`error`, `success`) live in `settings.custom.color` and bridge
to `--color-*` the same way.

Leave the token files as Static Kit stamped them. Do not put `--wp--preset--*`
inside Static Kit itself, and do not rewrite a project's copies to those names.
A reinstall restores the stamp, and the kit is host-agnostic on purpose.

`wonderpress lint` fails in both directions: a token file consumes a name
`theme.json` does not bridge, or `theme.json` bridges a name no token file
consumes. That is what catches a Static Kit release that renames `--type-h2-lh`
before a site silently falls back to the Sass default.

### Why the bridge lives in core

Static Kit is a **general** asset framework with no knowledge of WordPress —
grep it and there is not one reference. Teaching token files to reach for
`--wp--preset--*` in Static Kit itself would couple a WordPress-agnostic project
to WordPress, which is exactly the seam this document exists to protect.

`static/` is *installed* into a project rather than vendored. The bridge is the
host's half of the contract the token comments already describe, so it ships in
wonderpress-core and applies to every theme. A project adds a token the kit
does not ship (for example `$font-mono: var(--font-mono, …)`) in its own token
file, and adds the matching slot to `theme.json`. The lint check reads the
theme's token files, so that addition is part of the contract.

### The honest costs

- **Sass cannot compute with a custom property.** `darken($color-accent, 10%)`
  stops working, because the value does not exist until the browser resolves it.
  `color-mix()` covers most of what that was for; where it genuinely does not,
  declare that one derived colour as its own `theme.json` slot rather than
  reaching back for a literal.
- **Spacing is still an editor ladder only.** Static Kit has no spacing token
  file. `settings.spacing.spacingSizes` constrains the editor and is not bridged.

### The alternative, and why not

Generating `theme.json` from the SCSS tokens keeps Sass's colour maths intact.
It also buys a build step, and a `theme.json` nobody may hand-edit. Prefer the
subscription until something concrete makes the maths worth that.

## Ownership — who scaffolds what

| Artifact | Owner | How |
|---|---|---|
| PHP partial class + view template | **CLI** (the spine) | `partial create` |
| `.wonderpress/manifest/partials/*.json` (always) | **CLI** (the spine) | `partial create` |
| `blocks/<slug>/{block.json,render.php}` (opt-in) | **CLI** (the spine) | `partial create --block` |
| per-**component** SCSS/JS partial | **Static Kit** | `staticCli.component.create(...)` — the CLI *delegates* |
| per-**page** SCSS/JS entry | **Static Kit** | `staticCli.template.create(...)` — via `template create` |
| SCSS→CSS / JS bundling, per-page compile | **Static Kit** | `wonderpress static compile` delegates `staticCli.compile.all` |

**The CLI never writes into `static/` directly, and never auto-wires a partial
into an entry** — auto-wiring would pull a component into pages that don't use
it and break per-page tree-shaking. The `@use`/import into an entry is a
deliberate authoring act.

## CLI mapping

- `partial create` → a reusable component: emits the PHP class/view (wrapper
  class `<ns>-<slug>`, default `theme`) and the manifest; **delegates** the
  SCSS/JS component partials to `staticCli.component.create`. A partial is a
  rendering primitive, **not** a Gutenberg block — pass `--block` to also emit a
  `block.json` + `render.php` wrapper whose server render delegates back to the
  partial.
- `template create` → a page: **delegates** the per-page SCSS+JS entries to
  `staticCli.template.create`.
- `static compile` → from the environment root, **delegates** `compile.all`
  into that theme's `static/` (`--watch` stays on the CLI).
- A `--namespace <ns>` on `partial create` (default `theme`) selects the scope
  namespace; pass a page slug for a deliberately page-scoped partial.

## Invariant for the build-tool modernization (Vite re-home)

The **per-page conditional compile + load** (one bundle per template, enqueued
by `wonder_body_id()`, importing only what the page uses) is a **must-keep
behavior**. Vite code-splits natively, but the "one entry per template, loaded
conditionally" model — the thing that makes pages ship only what they need —
has to survive the swap.
