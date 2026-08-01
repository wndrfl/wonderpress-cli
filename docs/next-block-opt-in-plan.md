# Plan: block emission becomes opt-in (partial ≠ block)

Status: in progress on `feat/block-opt-in` (stacked on the PR #19 branch).

## The correction

A **partial** is a WonderPress rendering primitive — a button, a section, a
link. It turns properties into HTML (`Abstract_Partial`), is often used
compositionally *inside* other partials, and has no inherent relationship to
the editor.

A **block** is a formal WordPress notion: `block.json` + `register_block_type()`
is what surfaces something in the Gutenberg inserter. Its whole reason to exist
is *editor availability*.

They are orthogonal. The spine as shipped assumed **partial == block**: it
emits `block.json` by default (`--no-block` is opt-*out*), handing every
low-level partial editor-registration metadata it has no business carrying, and
the PHP side (`wonderpress-core`) never registers any of it — so block.json is
emitted into a void.

## The model

- **Partial = the rendering layer.** The manifest is the always-on spine output.
- **Block = an opt-in editor wrapper** whose `render` delegates back to the
  partial. "A block is a partial I also chose to expose in Gutenberg" — never
  the reverse.

## Work

### CLI — `wonderpress-cli` (PR 1 of 2)

1. Invert the flag: `--no-block` (opt-out) → `--block` (opt-in), default off.
   - `src/cli.js`: drop `--no-block`, add `--block: Boolean`.
   - `paramsFromFlags`: `block: !!args['--block']`.
   - `paramsFromJson`: `block: spec.block === true`.
   - `runWizard`: prompt "Also expose this partial as a Gutenberg block?",
     default No.
2. Stop the manifest advertising a block that doesn't exist: gate the manifest
   `block` field *and* `artifacts.block` on `emit.block === true`.
3. Make the emitted block render through its partial: generate
   `blocks/<slug>/render.php` (news up the partial class, echoes `->render()`)
   and add `"render": "file:./render.php"` to block.json. Dynamic,
   server-rendered, no editor build step for v1.
4. Tests: flip the emit tests from opt-out to opt-in — default run emits no
   block.json/render.php and a manifest with no `block` field; `--block` emits
   all three. `static-kit-contract.test.js` untouched.
5. Docs: note partial ≠ block and the opt-in wrapper model in ARCHITECTURE.md +
   the conventions doc.

### Core — `wonderpress-core` (PR 2 of 2, separate repo)

6. Add the missing consumption site: `add_action('init', …)` that scans the
   theme's `blocks/` dir and `register_block_type()`s each subdir. WordPress
   reads block.json + the `render` binding automatically; only opt-in partials
   produce a `blocks/<slug>/` dir, so only they register.
7. Register the `wonderpress` block category (`block_categories_all` filter) so
   the emitted `category: 'wonderpress'` resolves.

The two PRs meet only at the block.json shape — they land independently and
coordinate through that contract, per the seam model formalized in PR #19.

## Decisions taken

- **Render binding** lives in a generated `render.php` (self-contained block,
  generic core registration) rather than a PHP-side render-callback registry.
- **v1 is dynamic server-rendered blocks only** — no `edit.js`, no editor
  bundle. Defers the Gutenberg-JS / Vite editor-asset question to a later arc.

## Sequencing

Land after PR #19 merges. CLI PR first, then core PR.
