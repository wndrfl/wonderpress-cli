# Plan: editor JavaScript — visual fidelity without duplicating markup

Status: not started. The arc ROADMAP.md deferred ("no `edit.js`, no editor
bundle") and the requirement that ends the deferral.

## Why the deferral has to end

The requirement is *be as visual as we can in the editor while still supporting
full bespoke*. Nothing in the hybrid theme arc delivers it.

A block registered only on the server has **no editor preview**. `block.json`
plus `render: file:./render.php` makes WordPress render the block correctly on
the front end and gives it a name in the inserter, but the editor has no `edit`
component to draw, so the client does not see a testimonial — they see a
placeholder. Every lock, filter and token in the hybrid plan works today.
Visual fidelity does not.

This is also the trigger ROADMAP Phase 0 anticipated for the Vite question:
"re-home it when that question forces it, not before." Building editor
JavaScript is that question.

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

1. **A generic edit component.** One `edit.js` that reads the block's
   registered attributes and renders `<ServerSideRender>` plus auto-generated
   Inspector Controls — a text control for a string property, a toggle for a
   boolean, a select for an `enum`. Because it is driven by the attributes the
   manifest already describes, adding a property to a partial gets an editor
   control for free, with no per-block JavaScript.
2. **A build for it.** The first real editor bundle, and the moment to settle
   the Vite question rather than bolt another esbuild invocation onto Static
   Kit. Decide deliberately: the editor bundle needs the `@wordpress/*` packages
   resolved against WordPress's own script registry (`wp.element`, `wp.blocks`,
   and friends as externals), which is a genuinely different job from Static
   Kit's site bundles.
3. **Client-side registration.** `register_block_type()` on the server plus the
   matching `registerBlockType()` in the bundle, with `editorScript` in
   `block.json` pointing at it.
4. **Opt-in `InnerBlocks`.** A partial declares that it accepts inner content;
   the emitted block renders the shell and locks the children. Probably a
   manifest field and a flag, consistent with how `--block` and `--js` already
   work.
5. **Keep the no-JS path working.** A block with no editor bundle must still
   register and render on the front end. The editor experience degrades to
   today's placeholder; nothing breaks.

## Open questions

- Whether the generic edit component is shipped by **wonderpress-core** (one
  bundle for every project, versioned with the plugin) or emitted per theme by
  the CLI. Core is the better instinct — it is framework, not project code, and
  it would be identical in every theme — but that depends on core becoming a
  real versioned package, which is ROADMAP Phase 1's remaining item.
- Whether `ServerSideRender`'s latency is acceptable on partials that do real
  work, or whether it needs debouncing beyond the default.
- Whether Inspector Controls generated from primitive types are good enough in
  practice, or whether properties need presentation hints in the manifest.

## Dependencies

Do the hybrid theme arc first. The wrapper-attributes fix in particular
([hybrid-theme-plan.md](hybrid-theme-plan.md) §4) is a prerequisite: without
`get_block_wrapper_attributes()`, blocks carry no standard class and any
support enabled here produces controls that do nothing.

This arc should not start until the hybrid arc has been through a real editor
session in the sandbox. Building an editor experience on top of locks that have
not been verified by hand is building on an assumption.
