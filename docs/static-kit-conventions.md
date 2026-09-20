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

```
src/
├─ scss/
│  ├─ <page>.scss          ← per-page ENTRY (home.scss, single.scss, archive-*.scss …)
│  ├─ lib/                 ← shared: _global, _pallette, _variables (tokens), _mixins, _grid …
│  └─ partials/            ← per-COMPONENT styles: _<ns>-<slug>.scss
└─ js/
   ├─ <page>.js            ← per-page ENTRY (home.js, single.js …)
   └─ lib/
      ├─ global.js         ← init bundled into EVERY page (bootstraps theme-level JS)
      ├─ partials/         ← per-COMPONENT behavior: <Name>.js (class-based)
      ├─ mixins/ · utils/
```

## Namespaces communicate scope (where it lives / is used)

The prefix on a component's class is a **scope namespace**, a signal to devs:

- **`theme-<slug>`** — theme-level: reusable across pages (global). The default
  for a `partial` (an `Abstract_Partial` is reusable by construction).
- **`<page-slug>-<slug>`** — page-level: lives on / used only by that page
  (e.g. `.home-blogs` defined in `home.scss`).

A page entry composes both: theme-level partials it reuses **and** any
page-level ones specific to it.

## SCSS component partial

`src/scss/partials/_<ns>-<slug>.scss`, selector `.<ns>-<slug>`, composed from
tokens; BEM `&--modifier` / `&__element`:

```scss
@use "../lib/pallette" as *;
@use "../lib/mixins" as *;
.theme-cta-banner {
  @include section-padding;
  &--white { background-color: $color-white; }
}
```

Opt-in per page: an entry does `@use 'partials/theme-cta-banner';` only where
needed.

## JS component partial + global bootstrap

- `src/js/lib/partials/<Name>.js` — a `class <Name>` (component behavior;
  e.g. `ThemeBusinessBrowser`).
- `src/js/lib/global.js` — an **init function bundled into every page** that
  bootstraps theme-level JS that must load everywhere. (Name is a convention;
  could be renamed — `bootstrap`/`main` — if preferred.)
- Each page entry imports `global` + the partial classes that page needs and
  inits them — mirroring the SCSS entry's `@use` list.

## Design tokens: `theme.json` publishes, the project's SCSS subscribes

A WonderPress theme has two places that know what "accent" means, and they are
owned by different projects:

- **`theme.json`** declares the palette, font sizes and spacing ladder. This is
  what constrains the editor — it is the reason a client's colour picker offers
  three swatches instead of the spectrum.
- **`static/src/scss/lib/_pallette.scss`** declares the same values as Sass
  variables, for the CSS that actually renders the site.

Left alone, a project types its brand colours into both and they drift. Setting
brand colours is the first thing anyone does on a new project, so this is a day
one problem, not a someday one.

**The rule: `theme.json` is the source of truth. The SCSS subscribes.**

`theme.json` compiles each palette entry into a CSS custom property, so the
project's palette partial references those rather than restating the values:

```scss
// static/src/scss/lib/_pallette.scss — in a WonderPress project
$color-accent:   var(--wp--preset--color--accent);
$color-base:     var(--wp--preset--color--base);
$color-contrast: var(--wp--preset--color--contrast);
```

Declared once, in `theme.json`, and the editor and the stylesheet cannot
disagree about what the brand is.

### Why this is a convention and not a feature

Static Kit is a **general** asset framework with no knowledge of WordPress —
grep it and there is not one reference. Teaching `_pallette.scss` to reach for
`--wp--preset--*` in Static Kit itself would couple a WordPress-agnostic project
to WordPress, which is exactly the seam this document exists to protect.

It does not need to. `static/` is *installed* into a project rather than
vendored, and the palette partial is then the project's own file. So this is a
setup step a project takes, not a behaviour either tool imposes — which is why
it lives here as a convention rather than in anybody's code.

### The honest costs

- **Sass cannot compute with a custom property.** `darken($color-accent, 10%)`
  stops working, because the value does not exist until the browser resolves it.
  `color-mix()` covers most of what that was for; where it genuinely does not,
  declare that one derived colour as its own `theme.json` slot rather than
  reaching back for a literal.
- **Only colour maps cleanly today.** Static Kit's sole token file is
  `_pallette.scss`; type and spacing sizes are baked directly into `%h1`,
  `%title` and `%paragraph` placeholders rather than exposed as a named scale.
  `theme.json`'s type and spacing slots therefore *introduce* a scale rather
  than subscribing to one, and adopting them is a change to Static Kit's model.
  **Do colour now; treat type and spacing as their own decision.**

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
| SCSS→CSS / JS bundling, per-page compile | **Static Kit** | build step |

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
- A `--namespace <ns>` on `partial create` (default `theme`) selects the scope
  namespace; pass a page slug for a deliberately page-scoped partial.

## Invariant for the build-tool modernization (Vite re-home)

The **per-page conditional compile + load** (one bundle per template, enqueued
by `wonder_body_id()`, importing only what the page uses) is a **must-keep
behavior**. Vite code-splits natively, but the "one entry per template, loaded
conditionally" model — the thing that makes pages ship only what they need —
has to survive the swap.
