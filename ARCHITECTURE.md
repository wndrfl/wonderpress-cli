# Architecture

## WonderPress ↔ Static Kit

WonderPress and [Static Kit](https://github.com/wndrfl/static-kit) are separate
projects with a deliberate boundary. This document is the contract: it states
who owns what, so the seam stays clean as both projects evolve.

### Static Kit is a dependency, never vendored

The CLI declares `@wndrfl/static-kit-cli` as a normal dependency in
[`package.json`](package.json). It is consumed two ways:

- **Programmatically** — `wonderpress init` calls `staticCli.core.installKit()`
  ([`src/core.js`](src/core.js)), which copies the Static Kit framework into the
  theme's `static/` directory and runs `npm install` there.
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
| Component manifests (always emitted) | **WonderPress CLI** | `.../.wonderpress/manifest/*.json` |
| `block.json` + `render.php` (opt-in Gutenberg wrapper — `--block`) | **WonderPress CLI** | `.../blocks/<slug>/` |
| The `static/` tree (layout, `.staticrc`) | **Static Kit** | `wp-content/themes/wonderpress/static` |
| Component **style stubs** (token-only SCSS) | **Static Kit** | `static/` (created via delegation) |
| Component **behavior classes** (opt-in JS — `--js`) | **Static Kit** | `static/` (created via delegation) |
| `src/` → `dist/` asset compilation | **Static Kit** | `static/src`, `static/dist` |

### The manifest is the index

`.wonderpress/manifest/<slug>.json` is the CLI's record of what a component is
and what was written for it. `partial list`, `partial remove`, `block create`,
`block list`, and `block remove` all read it rather than scanning (and guessing
at) source files — so the manifest is authoritative, and the deletion list for a
removal is exactly what creation recorded.

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

### Versioning

The `@wndrfl/static-kit-cli` version range in [`package.json`](package.json) is
the single point of coordination between the two projects. A caret range is
intentional — these are first-party packages released in lockstep. Pin an exact
version only if you need to freeze against a specific Static Kit layout.
