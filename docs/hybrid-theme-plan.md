# Plan: the hybrid theme — a constrained editor, without becoming a block theme

Status: not started. Replaces the "slate" framing in ROADMAP.md Phase 2.

## The correction

The roadmap called for the block theme file set — `theme.json`, `templates/`,
`parts/` — under the banner "adopt the block theme file format; refuse the Site
Editor workflow." Examining what that format actually drags in changes the
conclusion: **take `theme.json`, stay classic.**

A block theme is not a declaration, it is a set of mechanical consequences that
begin the moment `templates/index.html` exists:

- Appearance → Widgets and Appearance → Menus are removed from wp-admin, and
  the Customizer is largely hidden. For clients who know where the Menus screen
  is, shipping a block theme is a retraining event.
- The Site Editor appears, and its Styles panel writes a `wp_global_styles`
  record into the **database** that outranks `theme.json`. Design changes that
  never appear in a pull request. That is not a stylistic objection to the Site
  Editor — it is a source-of-truth leak, in a toolkit whose organizing idea is
  that the repo tells the whole story.
- Header and footer become editable template parts. We would be opening
  something classic never opened, then spending effort locking it back down.

Meanwhile the requirement that looked like it needed a block theme — *clients
compose a full page, but not the header or footer* — is the classic model
exactly. `page.php` calls `get_header()`, `the_content()`, `get_footer()`. The
client owns the content area; the chrome is PHP they cannot reach. We get that
boundary by doing nothing.

A classic theme that ships a `theme.json` is a **hybrid theme** — a supported,
common configuration. It buys the token layer and the constrained editor without
any of the above.

## What we are actually building

Four pieces. Every one of them is PHP-side and classic-compatible.

### 1. `theme.json` — constrained, not empty

An empty `theme.json` is not neutral, it is *permissive*. WordPress core ships
its own, generous, and ours merges over it: ship `{}` and we have opted into a
full default palette, freeform color pickers, arbitrary font sizes, arbitrary
spacing, plus CSS variables for presets nobody uses.

- `settings.color.custom: false`, `customGradient: false`, `defaultPalette:
  false`, `defaultGradients: false`.
- `settings.typography.customFontSize: false`, `fluid: true`.
- `settings.spacing.customSpacingSize: false`, plus an explicit `spacingSizes`
  and `spacingScale: { "steps": 0 }` — without the latter we get WordPress's
  generated ladder *and* ours, side by side.
- `settings.appearanceTools: true`.
- Token **slots** defined with neutral placeholder values. Slots are structure;
  the values belong to the project.
- `styles` stays near-empty. That half encodes a look, and the look is not ours
  to ship.

This is worth doing on its own merits even if nothing else here lands: it
constrains the **core** blocks — paragraph, heading, image, group, columns,
buttons — which clients use constantly and which are wide open today.

**Token source of truth.** `theme.json` publishes CSS custom properties
(`--wp--preset--color--accent`); it has no knowledge of Static Kit's SCSS in
either direction. To avoid declaring every brand color twice, **`theme.json` is
the source and the SCSS subscribes** via `var(--wp--preset--color--accent)`.
The honest cost: a custom property is a runtime value, so Sass cannot compute
with it and `darken()` is no longer available — `color-mix()` covers most of
what that was for. The alternative (generate `theme.json` from SCSS tokens)
keeps the Sass math but buys a build step and a file nobody may hand-edit.

### 2. The curated suite — `allowed_block_types_all`

This PHP filter replaces WordPress's ~90 core blocks with the list we curate.
It is what turns "the block editor" into "our suite," and it is the direct
answer to clients asking for a kit they can build pages from.

The list should be **generated from `.wonderpress/manifest/`** plus a small
hand-picked set of core blocks (paragraph, heading, image, list), so the suite
is defined by what the spine has emitted rather than maintained by hand in a
second place. Same principle the manifest already runs on.

### 3. The lock dial — `block_editor_settings_all`

Bespoke and open composition are not a global setting; they are per page. The
`block_editor_settings_all` filter receives the post being edited, so
`templateLock` and `allowedBlockTypes` can vary per page template — one fully
locked, another wide open, decided in code.

- `templateLock: 'all'` — bespoke, code-rendered. Nothing moves.
- `templateLock: 'contentOnly'` — client-editable content in a frozen layout.
  The sweet spot most agencies skip.
- `templateLock: false` — open composition.

Coarser structural locking, where a whole post type must have a fixed shape,
uses `register_post_type`'s `template` and `template_lock` arguments.

The default lock level **rides in the component manifest**, so editability is
set at the contract rather than rediscovered per page: a `lock` field in the
manifest schema (defaulting to `contentOnly`), a `--lock` flag on `partial
create` / `block create`, carried through to `block.json`. Manifest changes are
additive — existing manifests without `lock` read as the default, and
`static-kit-contract.test.js` stays untouched.

**To verify, not assume:** `contentOnly` is well-established at the
container/`InnerBlocks` level. Whether it behaves as wanted at post-type level
needs a real editor session, not a reading of the docs.

### 4. Wrapper attributes — the prerequisite

`render.php` echoes the partial directly, so the rendered HTML carries none of
WordPress's generated block markup — including the `wp-block-wonderpress-*`
class. Two consequences: any block support we ever enable produces controls
that silently do nothing, and `theme.json`'s `styles.blocks` targeting matches
no selector.

Emit `get_block_wrapper_attributes()` from the render template. Small,
self-contained, and worth doing regardless of what else lands.

## On block `supports`

The instinct is to expose our blocks to `theme.json` settings by adding
`supports` to `block.json`. **Resist it for design controls.**

The moment a block supports per-instance color and padding, its appearance is
the SCSS *plus* whatever values sit in `post_content` across hundreds of pages.
"What does a testimonial look like" stops being answerable from the repo — by a
person or an agent — which is the property the whole toolkit is built on. It
also pulls against the lock dial: building a mechanism to freeze layout while
opening per-instance design controls is two mechanisms arguing.

The need behind the instinct is real. Serve it with **named variants instead**:
a `style` property with a code-defined set of choices, which flows through the
existing properties → attributes → `block.json` pipeline, is stored as a normal
attribute, and is rendered by SCSS. Flexibility within the design system rather
than an escape hatch out of it. This needs a fifth entry in `PROP_TYPES`
([src/validate.js](src/validate.js)) — an `enum` with allowed values, mapped to
a string attribute with an `enum` constraint.

**One exception:** `supports.spacing.margin`. "This section needs more room
above it on this page" is a genuine per-page need no variant system answers
well, and constrained to a `spacingScale` it is a choice from a named ladder
rather than an arbitrary number. Margin only — padding is internal design and
belongs to the component.

## Sequencing

1. `theme.json` — cheap, reversible, immediate win on core blocks, and it
   cannot break "classic-capable" because it does not touch the theme's type.
2. Wrapper attributes in `render.php` — small, unblocks everything downstream.
3. The curated suite off the manifests.
4. The lock dial, manifest `lock` field, and `--lock`.

Then the editor-JS arc, which is the genuinely large one — see
[editor-js-plan.md](editor-js-plan.md). Visual fidelity in the editor is the one
requirement none of the above delivers.

## Repos

- **wonderpress-development-environment** — `theme.json`, and the `style.css`
  header bump.
- **wonderpress-core** — the `allowed_block_types_all` and
  `block_editor_settings_all` filters, reading the manifests.
- **wonderpress-cli** — the `lock` manifest field, `--lock`, the `enum` property
  type, and `get_block_wrapper_attributes()` in the render template.

## Explicitly not in this arc

- `templates/` and `parts/`. Dropped, not deferred. They arrive only if
  something concrete demands them, and the burden of proof is on them.
- Correctness primitives — the next arc.
- Editor JavaScript — its own plan.
