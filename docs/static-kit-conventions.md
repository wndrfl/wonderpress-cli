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

## Ownership — who scaffolds what

| Artifact | Owner | How |
|---|---|---|
| PHP partial class + view template | **CLI** (the spine) | `partial create` |
| `block.json` + `.wonderpress/manifest/*.json` | **CLI** (the spine) | `partial create` |
| per-**component** SCSS/JS partial | **Static Kit** | `staticCli.component.create(...)` — the CLI *delegates* |
| per-**page** SCSS/JS entry | **Static Kit** | `staticCli.template.create(...)` — via `template create` |
| SCSS→CSS / JS bundling, per-page compile | **Static Kit** | build step |

**The CLI never writes into `static/` directly, and never auto-wires a partial
into an entry** — auto-wiring would pull a component into pages that don't use
it and break per-page tree-shaking. The `@use`/import into an entry is a
deliberate authoring act.

## CLI mapping

- `partial create` → a reusable component: emits the PHP class/view (wrapper
  class `<ns>-<slug>`, default `theme`), `block.json`, manifest; **delegates**
  the SCSS/JS component partials to `staticCli.component.create`.
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
