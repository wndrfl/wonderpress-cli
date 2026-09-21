# WonderPress Roadmap

Where the toolkit is, and what comes next. Derived from the July 2026
engineering brief; this file is the living version, and the brief's decision
rules in §10 still govern anything not settled here.

**The organizing idea.** WonderPress is not a WordPress boilerplate plus a build
tool — that category is commoditized and unwinnable. It is the convention layer
that makes a WordPress codebase legible to AI agents and portable to blocks. We
concede the commodity ground (project structure, local environment, bundling) by
adopting best-in-class tools underneath, and invest in the layers where our
opinions live.

**The rule that resolves most questions:** own the layers where we have an
opinion worth enforcing; wrap the plumbing we are merely afraid to depend on
someone else for. Owning an implementation decays. Owning an interface compounds.

---

## Status at a glance

| Phase | State |
|---|---|
| 0 — Re-home the plumbing | **Mostly done** — one item left (Static Kit → Vite) |
| 1 — Formalize core + contract | **Done** — core is a Composer dependency of the theme |
| 2 — Fire the spine + constrain the editor | **Done** — hybrid theme, wrappers, opt-in curated suite, page lock, and repo-authoritative Global Styles |
| 2b — Editor JavaScript | **Done** — buildless SSR preview, manifest-driven controls, dual types, and fidelity hardening |
| 3 — The AI layer | **Shipped (v1)** — JSON CLI, generated AGENTS.md, MCP stdio; axe/budget specified not built |
| 4 — Optional Figma | Not started |

Last verified: 2026-09-21, against CLI 2.9.0 / core 2.2.0 / Static Kit 2.13.0.
Phase 2 re-scoped 2026-09-14: block theme → hybrid theme.
Lock dial split into page-lock and block-lock 2026-09-15.
Product decisions below, 2026-09-21.

### Decisions, 2026-09-21

1. **Frozen layout with in-place text editing is not a v1 promise.** Root
   `contentOnly` does not freeze page composition, and React `InnerBlocks`
   cannot mount inside inert ServerSideRender HTML. Page lock accepts only
   `'all'`, `'insert'`, or `false`; content remains sidebar-authored.
2. **WordPress floor stays 6.6.** One custom `edit` for every WonderPress block.
   WP 7 `supports.autoRegister` is not the inspector path (it cannot author
   `object` / `array` attributes).
3. **Strip user Global Styles** so `theme.json` wins. ✅ Shipped; opt out per
   project with `wonderpress_strip_user_global_styles`.
4. **Curation stays off** until a project turns `WONDERPRESS_CURATE_BLOCKS` on.
   `wonderpress init` does not enable it.
5. **Order of work:** editor contract (docs matching code, then SSR fidelity)
   → correctness primitives → Phase 3. The editor contract shipped later that
   day; correctness primitives v1 (Image, Link, visually-hidden/skip-link
   contracts) shipped after it. Heading-level manager stays deferred.

---

## Phase 0 — Re-home the plumbing

| Item | State |
|---|---|
| Node LTS + native ESM (drop the `esm` shim) | ✅ Node >=24, `"type": "module"` |
| WPCS 2.x → 3.x | ✅ in wonderpress-core |
| Static Kit version fragmentation | ✅ lockstep releases, floor `^2.13.0` |
| Local environment → wp-env / DDEV | ✅ **CLI 2.6.0** — `init --env wp-env`, opt-in |
| Static Kit engine → Vite | ❌ still esbuild + sass directly |

**Remaining: Vite, for Static Kit, when Static Kit forces it.** Editor JavaScript
did **not** force this. Phase 2b shipped buildless against WordPress's `wp.*`
globals (`editor-preview.js` in wonderpress-core). There is no per-block
`editorScript` and no editor bundler. Do not re-home Static Kit "because
`edit.js`" — that justification is withdrawn.

### On the environment backend (shipped 2.6.0)

`wonderpress init --env wp-env` builds WordPress, MariaDB and a pinned PHP 8.2
in Docker with the project bind-mounted in. The backend is recorded in
`.wonderpressrc`, so `--env` is typed once. **Host remains the default.**

**Open decision:** flip the default to wp-env in 3.0.0 — but only after running
it on two or three real client projects. A hard Docker requirement on the happy
path does not feel reversible once shipped.

Honest limitation, worth repeating because people assume otherwise: wp-env
removes **MySQL** from the host requirements. It does not remove PHP, Composer
or WP-CLI.

---

## Phase 1 — Formalize the core and the contract

| Item | State |
|---|---|
| Flag-driven-first, wizard as a wrapper | ✅ `--json @file`, repeatable `--prop` |
| Abstract_Partial, validation engine, block registrar | ✅ in wonderpress-core |
| wonderpress-core as a *versioned* package | ✅ Composer dependency of the theme |

**Done.** Core is `wndrfl/wonderpress-core`, required by the theme's own
`composer.json` and installed to the theme's `vendor/`. The `git clone` into
mu-plugins is gone.

It went into the *theme* rather than staying a Composer-managed mu-plugin for
two reasons. Nothing in core needs mu-plugin load order — its earliest hook is
`init` — and core cannot function without a theme anyway, since it registers the
blocks in `get_stylesheet_directory()/blocks` and resolves its partial views
through `locate_template()`. Putting it in the theme makes deleting the theme
remove WonderPress with it, which is the removability property the toolkit
previously asserted nowhere and implemented nowhere.

`vendor/` and the theme's `composer.lock` are committed, so a deploy still needs
no Composer step while `composer update wndrfl/wonderpress-core` becomes the
upgrade lever. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full contract.

---

## Phase 2 — Fire the spine, constrain the editor

### The spine fires ✅

One definition emits: PHP class + view + `block.json` + `render.php` + Static Kit
style stub + opt-in JS behavior + agent manifest. wonderpress-core registers the
blocks and the `wonderpress` category.

This is the brief's central diagram, working. As of 2.6.0 it is also *provable*
without clicking:

```bash
wp-env run cli wp eval \
  'var_dump( WP_Block_Type_Registry::get_instance()->is_registered("wonderpress/testimonial") );'
```

### Constraining the editor — mostly shipped

The shipped theme is a classic PHP theme with a constrained `theme.json`, blocks
that carry wrapper attributes, blocks published under the **project's**
namespace rather than WonderPress's, an opt-in curated suite, and a page lock
dial. See [docs/hybrid-theme-plan.md](docs/hybrid-theme-plan.md).

> **Superseded, Sep 2026.** This arc was framed as "the slate": `theme.json`
> *plus* `templates/` *plus* `parts/` — becoming a block theme, on the premise
> that we could "adopt the block theme file format and refuse the Site Editor
> workflow." Those turn out not to be cleanly separable, and the framing is
> withdrawn.

`templates/index.html` is the single switch that makes WordPress treat a theme
as a block theme, and it brings three things with it: the Site Editor appears,
the Menus and Widgets screens are removed from wp-admin, and the Styles panel
starts writing a `wp_global_styles` **database** record that outranks
`theme.json`. That last one is not a taste objection — it is a source-of-truth
leak in a toolkit whose organizing idea is that the repo tells the whole story.

Meanwhile the requirement that looked like it needed a block theme — *clients
compose the page body, but not the header or footer* — is precisely what a
classic theme does by default. `get_header()`, `the_content()`, `get_footer()`.

**The position now: take `theme.json`, stay classic.** A hybrid theme.

- **`theme.json`, constrained not empty.** ✅ **Shipped** —
  wonderpress-development-environment#11. An empty one is *permissive* — any
  color, any size. Define token slots and switch off freeform choices.
  Unopinionated about what the brand is; opinionated that it arrives via tokens.
  It is also the **source of truth** for tokens, with Static Kit's SCSS
  subscribing to the generated custom properties rather than declaring them a
  second time. Verified in the sandbox: `wp_is_block_theme()` stays `false`, the
  editor offers our eight colors and nothing else, and the custom pickers are
  gone.

  **Measured correction to the brief:** constraining `theme.json` does *not*
  shrink the global-styles payload — it grows it, 10,190 → 14,319 bytes. Core's
  preset variables are emitted regardless of `defaultPalette` /
  `defaultSpacingSizes`; those flags govern what the **editor offers**, not what
  CSS is generated. The win is constraint, not bytes. Trimming the emitted CSS
  is a separate problem with a separate mechanism, and is not yet planned.

  **User styles.** ✅ Core filters `wp_theme_json_data_user` so database-backed
  styles cannot outrank the file. A project that intentionally uses the Global
  Styles UI opts out through `wonderpress_strip_user_global_styles`.
- **The curated suite** — ✅ **Shipped**, wonderpress-core#7. Opt-in via
  `WONDERPRESS_CURATE_BLOCKS`; 117 blocks become 6. **Off until a project turns
  it on** — including new `init`. The list comes from what WordPress actually
  registered, **not** from the manifests: the manifest indexes partials, the
  allowed list wants blocks. That also keeps hand-written blocks working.
- **The lock dial** — two dials, not one. *Page* lock is a fact about the page
  and rides on the page template via `block_editor_settings_all` /
  `wonderpress_template_locks` / page-template manifests (`editor.lock`).
  **Shipped.** Use `'all'` (nothing moves), `'insert'` (reorder only), or
  `false` (open composition). `'contentOnly'` is **not** a page-lock value: at
  the root, Gutenberg still allows add/remove/move. PHP and CLI reject
  `contentOnly` in page-template mappings.
- **Wrapper attributes** — ✅ `render.php` emits
  `get_block_wrapper_attributes()`.

`templates/` and `parts/` are **dropped, not deferred**. The burden of proof is
on anything that wants to reintroduce them.

**Why the environment work came first:** none of this can be verified by
asserting on emitted files. Lock behaviour is load-and-click work.
`./sandbox/bootstrap.sh --env wp-env --fresh` is the loop.

### Editor JavaScript — shipped buildless; fidelity remaining

A block registered only on the server has **no client `edit`**: WordPress stores
the server metadata, but the inserter and canvas need `registerBlockType()` with
an `edit`. Phase 2b ended the "no editor JavaScript" deferral.

**What shipped.** One buildless script in wonderpress-core
(`assets/js/editor-preview.js`), enqueued on `enqueue_block_editor_assets`. It
registers each theme block on the client, draws Inspector Controls from
`window.wonderpressBlockSchemas` (manifest property types), and previews via
`ServerSideRender` so the PHP partial stays the only source of HTML. Generated
`block.json` has no `editorScript`. Dual-authorable types through `image`,
`link`, `post_object`, `repeater`, and `partial` embeds are in
`DUAL_AUTHORABLE_TYPES` with PHP normalization
(`wonder_normalize_property_value`). Details:
[docs/editor-js-plan.md](docs/editor-js-plan.md),
[docs/property-value-shapes.md](docs/property-value-shapes.md).

**Fidelity pass shipped, 2026-09-21.**

- SSR uses POST for structured attributes, strips block-support attributes from
  the response to avoid double wrappers, disables interactive preview HTML,
  supplies a named error state, and warns when a required `wp.*` global is
  absent. `ServerSideRender` already adds the current editor `post_id`; no
  generated `usesContext` metadata is needed for preview parity.

**Explicitly deferred, not Phase 2b gates.**

- **InnerBlocks / in-place editing.** ServerSideRender produces inert RawHTML;
  Gutenberg's React `InnerBlocks` cannot occupy a slot inside that PHP shell.
  Revisit only if WordPress provides a server-shell slot API, or if WonderPress
  deliberately relaxes its no-duplicate-markup rule.
- **Stored attribute migrations.** Renaming or retyping a property in live
  block content still requires a project migration. A future versioned manifest
  design may automate this; `partial sync --migrate` is not specified enough to
  ship honestly.

Vite is not part of this arc.

### Correctness primitives — v1 shipped (Image, Link, contracts)

"Unopinionated" spans three axes and conflating them is the trap: **aesthetics**
→ ship nothing. **Architecture** → ship structure. **Correctness (a11y,
performance, semantics)** → not a matter of opinion at all. There is one right
answer and everything else is a bug. Ship it.

A primitive must pass all three tests: one correct implementation that is
project-invariant; zero visual opinion; and removing it would make every project
re-derive the same correctness and some would get it wrong.

They are not all `Abstract_Partial` clones. Split the list:

**Markup primitives (core partials)**

- **Image** — default `loading="lazy"` and `decoding="async"`; width/height
  when known (ACF size dims, never invented); native `srcset`/`sizes` from
  `wp_get_attachment_image_*` unless the caller passes an art-direction
  **array** (that is the only `<picture>` path); `fetchpriority` via attributes
  only. kses allows `decoding`, `srcset`, `sizes`, `fetchpriority`.
- **Link** — new-tab `rel` merges `noopener noreferrer` with caller tokens
  (e.g. `nofollow`); `type` builds `mailto:` / `tel:` / permalink hrefs. No
  visual variants. Simple `type: link` stays a property shape, distinct from
  `partial: "link"`.

**Contracts (not authorable partials)**

- **Visually hidden** — Static Kit `static/src/scss/lib/_utilities.scss`,
  WordPress class `.screen-reader-text`, `@use`'d from every page entry.
- **Skip-link** — theme boilerplate in `header.php` (`href="#main"` after
  `wp_body_open`). `:focus` reveal stays in theme `style.css`. Not a core
  helper or manifest.

**Deferred — harmful if naive**

- **Heading-level manager** — do not ship a global counter or default
  components to `h1`. Page title owns `h1`; reusable partials start at `h2`
  unless passed a tag. A correct manager would be an explicit region helper,
  not a side effect of `render()`. Until generated partials exist in volume,
  document the convention only.
- Later markup/behavior candidates: button (element choice, not styles), form
  inputs, dialog/disclosure, icon wrapper (`aria-hidden` vs labelled SVG).

"Card" or "Hero" have crossed into opinion — those are components, generate
them.

**Phase 3 is no longer blocked on Image/Link.** An agent that generates a Hero
should compose the Image primitive rather than invent an `<img>`.

---

## Phase 3 — The AI layer

**v1 shipped.** The CLI is the API; an agent is a second client. Judgment
(the PHP view and SCSS) stays with the author. Deterministic work stays in
the CLI. No agent, or an agent you do not trust yet, and `wonderpress` still
works.

| Slice | State |
|---|---|
| `--format json` envelope + exit `0`/`1`/`2` | ✅ list, check-drift, sync --dry-run, lint, version |
| Generated `AGENTS.md` (`CLAUDE.md` pointer) | ✅ `wonderpress agents write`; refreshed on init/create/sync |
| MCP stdio in this package | ✅ `wonderpress mcp` — same ops, not a second validator |
| `lint` includes manifest drift | ✅ phpcs then `check-drift --all` |
| axe pass | Specified — `wonderpress lint --axe` skips with a warning until implemented |
| Static Kit dist budget | Specified — `wonderpress lint --budget` skips with a warning until implemented |

MCP write tools: `partial_create`, `partial_sync`, `block_create`,
`template_create`. Removes require `confirm: true`. `init` / `destroy` /
`server` are not tools.

The flag-driven refactor (Phase 1) was the hinge this turns on, and it is done.

---

## Phase 4 — Optional Figma

Not started. **Tokens first** (Figma variables ↔ `theme.json`) — stable,
structured, high-ROI. Component-level Code Connect is the second, more advanced
move, behind an opt-in flag.

Hold the line at **handoff clarity**. Code stays canonical; Figma is a view onto
the contract, never a dependency of it. Figma-as-production-source is the tar
pit — do not promise it internally.

---

## Non-goals

- Out-Rooting Roots on structure, environments or bundling. We adopt those and
  compete one layer up.
- Page builders. Never.
- Headless WordPress — that need routes to Sanity instead.
- Figma as a production source.
- A Vite (or any) bundler for the block editor script, unless a future
  constraint actually requires one.
- WordPress 7 `autoRegister` as the WonderPress inspector.
- `templates/` and `parts/`.

**Platform boundary:** WordPress when an integrated CMS with WYSIWYG fidelity for
non-technical clients is the point. Sanity when structured content with a custom
front end is the point.

---

## Recommended order

1. ~~**`theme.json`**~~ ✅
2. ~~**Wrapper attributes in `render.php`**~~ ✅
3. ~~**Curated suite (opt-in) and page lock (`all` / `insert` / `false`)**~~ ✅
4. ~~**Package wonderpress-core**~~ ✅
5. ~~**Editor contract** — docs match code; SSR fidelity pass shipped.~~ ✅
6. ~~**Correctness primitives**~~ ✅ v1 — Image/Link raised to spec; visually-hidden in Static Kit; skip-link stays theme chrome; heading manager deferred.
7. ~~**Phase 3**~~ ✅ v1 — JSON CLI, AGENTS.md, MCP stdio, lint+drift. axe and dist budget remain specified.

The wp-env default flip stays opportunistic: take it when something forces the
question. Static Kit → Vite the same way.
