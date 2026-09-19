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

### 1. `theme.json` — constrained, not empty ✅ SHIPPED

wonderpress-development-environment#11.

An empty `theme.json` is not neutral, it is *permissive*. WordPress core ships
its own, generous, and ours merges over it: ship `{}` and we have opted into a
full default palette, freeform color pickers, arbitrary font sizes and
arbitrary spacing.

- `settings.color.custom: false`, `customGradient: false`, `defaultPalette:
  false`, `defaultGradients: false`.
- `settings.typography.customFontSize: false`, `defaultFontSizes: false`,
  `fluid: true`.
- `settings.spacing.customSpacingSize: false`, `defaultSpacingSizes: false`,
  plus an explicit `spacingSizes` ladder.
- `settings.appearanceTools: true`.
- Token **slots** defined with neutral placeholder values. Slots are structure;
  the values belong to the project.
- `styles` stays near-empty. That half encodes a look, and the look is not ours
  to ship.

`defaultFontSizes` / `defaultSpacingSizes` are the **v3** opt-outs and are
cleaner than the v2 `spacingScale: { "steps": 0 }` trick, but they landed in WP
6.6 — so `"version": 3` means the theme requires 6.6.

This is worth doing on its own merits even if nothing else here lands: it
constrains the **core** blocks — paragraph, heading, image, group, columns,
buttons — which clients use constantly and which are wide open today.

**Verified in the sandbox**, not asserted: `wp_is_block_theme()` returns
`false`, the editor palette is our eight slugs with core's defaults absent, and
`disableCustomColors` / `disableCustomFontSizes` are both `true`.

**Measured correction.** The brief claimed an unconstrained `theme.json` makes
WordPress emit a bloated global-styles blob, implying constraint trims it. It
does not — the payload *grows*, 10,190 → 14,319 bytes, because core's preset
variables are emitted regardless of `defaultPalette` and `defaultSpacingSizes`.
Those flags govern what the **editor offers**, not what CSS is generated. The
win here is constraint, not bytes; trimming the emitted CSS is a separate
problem with a separate mechanism, and is not yet planned.

**Token source of truth.** `theme.json` publishes CSS custom properties
(`--wp--preset--color--accent`); it has no knowledge of Static Kit's SCSS in
either direction. To avoid declaring every brand color twice, **`theme.json` is
the source and the SCSS subscribes** via `var(--wp--preset--color--accent)`.
The honest cost: a custom property is a runtime value, so Sass cannot compute
with it and `darken()` is no longer available — `color-mix()` covers most of
what that was for. The alternative (generate `theme.json` from SCSS tokens)
keeps the Sass math but buys a build step and a file nobody may hand-edit.

**This is not one migration, it is two.** Static Kit's only real token file is
`_pallette.scss`, so **color** is a straight swap — the slugs shipped in #11
mirror it exactly. **Type and spacing have no counterpart to mirror**: the SCSS
bakes sizes directly into `%h1` / `%title` / `%paragraph` placeholders rather
than exposing a named scale. Those slots therefore *introduce* a scale, and
adopting them is a change to Static Kit's model rather than a subscription to
an existing one. Sequence the color swap first; treat type and spacing as their
own decision.

### 2. The curated suite — `allowed_block_types_all` ✅ SHIPPED

wonderpress-core#7. This PHP filter replaces WordPress's 117 registered blocks
with the list we curate — what turns "the block editor" into "our suite," and
the direct answer to clients asking for a kit they can build pages from.

**Corrected during the build: the list does not come from the manifest.** The
plan said to generate it from `.wonderpress/manifest/partials/`, on the principle that
the manifest is the index. But the manifest indexes *partials*, most of which
are not blocks, while the allowed list wants *block names* — and core already
registers those blocks itself, so it can simply keep what it registered rather
than re-deriving the list from files afterwards.

That is also more truthful. A block whose metadata WordPress rejected never
enters the list, so it cannot be offered in the inserter as though it exists.
And it is what makes a **hand-written** block work: WordPress registers any
`blocks/<slug>/block.json` it finds, manifest or no manifest, so a
manifest-derived list would have left such a block registered, rendering, and
silently un-insertable. (See wonderpress-cli#37, which fixed the matching blind
spot in `block list`.)

Recording what was registered also let the category lookup drop its redundant
second scan — `blocks.php` no longer touches the filesystem outside
registration.

**Opt-in**, via `WONDERPRESS_CURATE_BLOCKS` / the `wonderpress_curate_blocks`
filter, matching the theme's existing `WONDERPRESS_DEQUEUE_BLOCK_CSS`
convention. On by default would strip most of the block library from existing
client sites on update, and which blocks a client gets is a project decision
rather than a framework one.

Verified in the sandbox: 117 blocks → 6 with curation on; and a curated-out
block (`core/quote`) stays registered and keeps rendering in content that
already uses it, so curating a live site does not break its existing pages.

### 3. The lock dial — two dials, not one

**Corrected Sep 2026.** This section previously said both "bespoke and open
composition are per *page*" and "the default lock level rides in the component
*manifest*". Those cannot both describe one setting, and the second is wrong.

Picture an About page carrying a hero, a testimonial and a call-to-action, each
with a lock level from its own manifest. What is the page's lock level? There is
no answer — the page has exactly one, and three components are each claiming it.
Underneath that: a component does not know what page it is on. The same
testimonial may sit on a locked bespoke landing page and on an open blog post,
so "the testimonial's lock level" cannot answer "can this page be rearranged."
It is not a fact about the testimonial.

There are two real settings. Both are wanted. They live in different places.

#### 3a. Page lock — can this page be composed at all?

Whether the client may add, remove and reorder the **top-level** blocks on a
page. A fact about the page, so it belongs to the page template: a bespoke
landing page is locked, a standard content page is not.

`block_editor_settings_all` receives the post being edited, so this is a small
mapping in PHP from page template to lock level, declared once:

- `templateLock: 'all'` — bespoke, code-rendered. Nothing moves.
- `templateLock: 'contentOnly'` — client-editable content in a frozen layout.
  The sweet spot most agencies skip.
- `templateLock: false` — open composition.

Coarser structural locking, where a whole post type must have a fixed shape,
uses `register_post_type`'s `template` and `template_lock` arguments.

This still meets the goal the original section was reaching for — editability
set at the contract rather than rediscovered per page. The contract for *page*
editability is simply the page template, not the component. Declare it once, and
every page on that template inherits it.

**To verify, not assume:** `contentOnly` is well-established at the
container/`InnerBlocks` level. Whether it behaves as wanted at post-type level
needs a real editor session, not a reading of the docs.

#### 3b. Block lock — can this block's insides be rearranged?

Whether the client may restructure a block's **inner** content: in a testimonial
holding a quote and a citation, can the citation move above the quote, or only
its words change. That genuinely is a fact about the component, and it genuinely
does belong in the manifest — a `lock` field, a `--lock` flag on `partial
create` / `block create`, carried through to `block.json`. Additive, so existing
manifests without it read as the default and `static-kit-contract.test.js` stays
untouched.

**But it has nothing to act on yet.** A block's `templateLock` governs its
`InnerBlocks`, and our blocks have none — they are server-rendered from the
partial, with no inner content for a client to rearrange. So this half waits on
the `InnerBlocks` work in [editor-js-plan.md](editor-js-plan.md); shipping a
`--lock` flag before then would write a field nothing reads.

#### Sequencing

Build **3a now** — it is self-contained, PHP-side, and the piece that actually
answers "bespoke pages and client-composed pages in one theme". Build **3b with
`InnerBlocks`**, not before.

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
