# Plan: editor JavaScript — visual fidelity without duplicating markup

Status: mostly shipped (Phase 2b). wonderpress-core enqueues one buildless
`editor-preview.js`: client `registerBlockType()`, ServerSideRender preview,
Inspector Controls for every dual-authorable type (scalars plus `image`,
`link`, `post_object`, `repeater`, `partial`). SSR fidelity pass shipped
2026-09-21; InnerBlocks remains. Vite is not part of this arc — see ROADMAP
Phase 0.

## Why the deferral has to end

The requirement is *be as visual as we can in the editor while still supporting
full bespoke*. Nothing in the hybrid theme arc delivers it.

A block registered only on the server has **no client `edit`**. `block.json`
plus `render: file:./render.php` makes WordPress render the block on the front
end, but without `registerBlockType()` the inserter and canvas have nothing to
draw. That is why this arc existed. The generic `edit` is now that registration.

That was also expected to force the Vite question in ROADMAP Phase 0. It did
not. The editor script runs against `wp.*` globals WordPress already enqueues.
Static Kit may still move to Vite on its own schedule; this file is not that
trigger.

## The constraint that shapes everything

The spine's central property is that **the PHP partial is the single source of
HTML**. `render.php` exists precisely so a block cannot carry markup of its own.

The obvious way to get an editor preview — write a JS `edit` component that
reproduces the markup in JSX — destroys that. Every block would have its design
declared twice, in two languages, drifting. Any approach that duplicates markup
is disqualified no matter how good the editing experience is.

## The two mechanisms, for two different jobs

### `ServerSideRender` — accurate preview, zero duplication

`@wordpress/server-side-render` renders a block by asking the server for it over
REST and displaying the returned HTML. The PHP partial stays the only source of
markup. Core uses it for blocks like Latest Posts.

Honest costs: a round-trip on every attribute change, so editing feels slightly
laggy; and the output is inert HTML, so the client edits values in the sidebar
(Inspector Controls) rather than typing on the page.

This is the default for every emitted block. It is generic — the same edit
component works for every WonderPress block, parameterized by name and
attributes — which means **one shared editor bundle, not one per block.**

### `InnerBlocks` with `templateLock` — in-place text editing

What `ServerSideRender` cannot do is let someone type directly into the design.
For that, the block renders its shell in PHP and nests real core blocks inside
for the text: a locked shell with a quote paragraph and a citation heading in
it. The client types in place, sees the actual design, and cannot restructure
anything.

The shell stays in PHP. The text is core blocks. Nothing is duplicated.

Together these get close to full fidelity: layout and shells rendered by our
PHP, text edited in place, everything else in the sidebar against a live
preview.

## Work

1. **A generic edit component.** ✅ One `editor-preview.js` that reads
   `window.wonderpressBlockSchemas` and renders ServerSideRender plus inspector
   controls. Adding a property to a partial gets an editor control for free.
2. **A build for it.** ❌ withdrawn. Buildless against `wp.*`. Core is a
   versioned Composer package; the script ships with it.
3. **Client-side registration.** ✅ `register_block_type()` on the server plus
   `registerBlockType()` in the core script. No `editorScript` in generated
   `block.json` — core enqueues the script once for all theme blocks.
4. **Opt-in `InnerBlocks`.** Not started. A partial declares that it accepts
   inner content; the emitted block renders the shell and locks the children.
   This is also how "frozen layout, editable text" is delivered at page level
   (`role: "content"` on text attributes). Page-level `contentOnly` is not a
   substitute — see ROADMAP decisions 2026-09-21.
5. **Keep the no-JS path working.** Front-end `render.php` still works if the
   editor script fails to load. The inserter will not, because WordPress still
   needs a client `edit`. Missing WordPress globals now name themselves in a
   console warning rather than failing silently.

**Fidelity pass:** ✅ `httpMethod: 'POST'` on SSR (repeaters can overflow GET);
`skipBlockSupportAttributes` so the inner server-rendered wrapper does not
duplicate support styles applied by the editor wrapper; disabled interactive
HTML in the canvas; named render error state; warning when `wp.*` is missing.
WordPress's `ServerSideRender` component already adds the current editor
`post_id`, so no generated `usesContext` metadata is needed. WordPress 7
`autoRegister` is **not** the path (theme Requires at least 6.6; object/array
attributes get no auto-inspector).

## Open questions

- ~~Core vs per-theme bundle.~~ **Core.** Shipped.
- ~~Extra debounce beyond ServerSideRender's default.~~ Default (~500ms) is
  enough until a measured problem says otherwise.
- Whether Inspector Controls generated from types are good enough, or whether
  properties need presentation hints in the manifest. Still open, not blocking.

## Dependencies

Wrapper attributes (`get_block_wrapper_attributes()` in `render.php`) shipped.
Hybrid page lock shipped with `'all'` / `'insert'` / `false`. InnerBlocks wait
on this file's remaining work, not the reverse.
