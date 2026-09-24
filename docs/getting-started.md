# Starting a WonderPress project

The order to do things in, and which decisions you cannot take back.
[README.md](../README.md) is the command reference; this is the narrative.

## What you need

- **Node >= 24**, and `wp` (WP-CLI), `php` and `composer` on PATH.
- Then **either** a running MySQL (the `host` backend, the default) **or**
  Docker Desktop (the `wp-env` backend).

wp-env replaces MySQL, not the PHP toolchain: `wp core download` still runs on
your machine, and `composer` still produces the `phpcs` that `wonderpress lint`
uses. Both backends need all four tools.

## 1. Build the environment

```bash
wonderpress init --dir ~/projects/acme --env wp-env --namespace acme --theme acme
```

That clones the development environment, downloads WordPress, creates the
database, installs wonderpress-core at its pinned version, installs Static Kit,
and activates the theme. On the `wp-env` backend the site is already serving
when it finishes; on `host`, run `wonderpress server`.

`--env` is only needed here — the backend is recorded in `.wonderpressrc`, so
every later command knows what kind of project this is.

## 2. The one decision you cannot take back

**`--namespace`.** Blocks are emitted as `<namespace>/<slug>`, and WordPress
writes that into page content:

```html
<!-- wp:acme/pull-quote {"quote":"…"} /-->
```

So it is a commitment to *content*, not a naming preference. Change it later and
every block already placed on every page becomes unrecognised — the content
survives, but WordPress no longer knows what renders it.

Give it the client's name. It defaults to the theme slug, and it is pinned in
`.wonderpressrc` at init so it cannot drift afterwards.

Everything else below can be changed whenever you like.

## 3. Set up the design tokens

**Put the brand in `theme.json`** — `wp-content/themes/<theme>/theme.json`.
Replace the placeholder palette with the real one. This file is the source of
truth, and it is what constrains the editor: it is the reason a client's colour
picker offers your five swatches instead of the spectrum.

**Then point the SCSS at it**, in `static/src/scss/lib/_pallette.scss`:

```scss
$color-accent:   var(--wp--preset--color--accent);
$color-base:     var(--wp--preset--color--base);
$color-contrast: var(--wp--preset--color--contrast);
```

Now a colour is typed once. The cost is that Sass can no longer compute with it,
so `darken($color-accent, 10%)` is gone — use `color-mix()`, or declare the
derived colour as its own `theme.json` slot. Full reasoning in
[static-kit-conventions.md](static-kit-conventions.md).

> **Colour only, for now.** Static Kit bakes type and spacing sizes into `%h1` /
> `%title` / `%paragraph` placeholders rather than naming a scale, so
> `theme.json`'s type and spacing slots have nothing to subscribe *to*. Set them
> if you want the editor constrained, but expect to maintain them alongside the
> SCSS until that is resolved.

WonderPress also discards database-backed user Global Styles, which otherwise
outrank this file without producing a repository diff. A project that
intentionally uses the Global Styles UI can opt out:

```php
add_filter( 'wonderpress_strip_user_global_styles', '__return_false' );
```

## 4. Curate the editor

A stock WordPress offers 117 blocks. Once you know which ones the client
actually needs, in the theme's `functions.php`:

```php
define( 'WONDERPRESS_CURATE_BLOCKS', true );
```

That narrows the inserter to your own blocks plus a small core set — paragraph,
heading, list, list-item, image. Adjust with the
`wonderpress_allowed_core_blocks` filter.

Safe to turn on mid-project: it governs what can be **inserted**, so pages
already built with other blocks keep working.

## 5. Lock the pages that should be locked

Which pages a client may restructure follows from the page template, declared
once:

```php
add_filter( 'wonderpress_template_locks', function () {
	return array(
		'page-landing.php' => 'all',     // bespoke, code-rendered — nothing moves
		'default'          => false,     // open composition
	);
} );
```

`default` covers pages on no particular template. A template you do not name is
left exactly as WordPress configured it — absent is not the same as `false`, so
this cannot accidentally unlock something.

Accepted values: `'all'` (nothing moves), `'insert'` (reorder only), `false`
(open). Do not use `'contentOnly'` here — at the root of the editor Gutenberg
still allows add/remove/move. Frozen layout with in-place text editing is not
part of WonderPress's v1 editor contract; content is edited through block
sidebar controls.

## 5a. Install ACF if PHP templates will hydrate from fields

`init` does not install ACF. Core no-ops when the plugin is missing; `--acf` on
a partial only marks the manifest. Repeaters and the other ACF-shaped types
need **ACF PRO**:

```bash
ACF_PRO_LICENSE=... wonderpress acf install
```

The key is read from the environment only — never as a CLI flag. `--free`
installs the official free zip from advancedcustomfields.com (not the
WordPress.org slug); it does not include Repeater. See `wonderpress acf help`.

Installing the plugin does not persist the PRO license for updates. Put
`define( 'ACF_PRO_LICENSE', '…' );` in `wp-config.php`, or activate it under
ACF → Updates.

## 5b. Locate ACF groups on the templates that own them

`--acf` records that a partial may register an ACF field group. Core reads the
manifest on `acf/init` and registers the group **only where you locate it**.
Partial manifests declare **fields only** — not ACF location rules. A group
with no location is skipped — otherwise a Hero metabox and a Hero block would
appear on the same screen.

**Locate partials** in either of these ways:

1. **Template composition** (preferred) — list the partial in
   `.wonderpress/manifest/page-templates/*.json` `composition`. Core derives
   page-template location from that file.
2. **`wonderpress_template_fields` filter** — explicit PHP map when you are not
   using composition:

```php
add_filter( 'wonderpress_template_fields', function () {
	return array(
		'template-landing.php' => array( 'hero', 'testimonials' ),
	);
} );
```

Do **not** use the `default` key unless you want those partials on every page
that uses WordPress’s default template.

That landing page hydrates from ACF and typically locks `'all'`:

```php
( new \Wonderpress\Partials\Hero( wonder_partial_props( 'hero' ) ) )->render();
```

`wonder_partial_props( 'hero' )` is `array( 'acf' => get_field( 'hero' ) )`.
On a blog post you insert the Hero block instead; the group does not show.

Property types `string`, `boolean`, `email`, `select`, `post_object`, `image`,
`link`, and `repeater` become ACF fields. Optional `label`, `when`
(conditionals by sibling property name), and whitelisted `acf` overrides are
supported (Pass 1).

Dual partials (`--acf` and `--block` together) use **dual-authorable** types
(image, link, post_object, repeater, partial embed, and Tier A scalars) — see
[dual-authorable-types.md](dual-authorable-types.md) and
[property-value-shapes.md](property-value-shapes.md).

**Manifest-first:** field definitions live in
`.wonderpress/manifest/partials/*.json`, not in the PHP class. After editing a
manifest, run `wonderpress partial sync <Name>` so `$_properties` and
`block.json` stay aligned. See [manifest-first-partials.md](manifest-first-partials.md).

Nested `type: "link"` on another partial still maps to a **simple** four-field
link group. To embed the **rich** Link primitive inside another partial, use
`type: "partial"` and `partial: "link"` (fields come from core
`manifest/partials/link.json`):

```json
{
  "name": "cta",
  "type": "partial",
  "partial": "link",
  "label": "Call to action"
}
```

In PHP, render with `wonder_render_partial_ref( 'link', $this->cta )` or
`new \Wonderpress_Core\Partials\Link( [ 'acf' => $this->cta ] )`.

The standalone **Link** primitive manifest is also available via:

```bash
wonderpress partial install-manifest link
```

Core ships `manifest/partials/link.json` (loaded automatically for ACF
registration when the partial is located). The PHP class is
`Wonderpress_Core\Partials\Link` in wonderpress-core. Repeaters are one level
deep (`--sub` or nested `properties` in `--json`). Flexible content is not
generated.

## 5c. Template manifests (composition + editor contract)

`wonderpress template create` writes `.wonderpress/manifest/page-templates/template-{name}.json`
with `"schemaVersion": 1`. That file declares:

- **`editor.lock`** — same values as `wonderpress_template_locks` (manifest
  defaults; your PHP filter still wins on the same template key).
- **`editor.acf`** — ACF field-group options for this template. Optional
  **`tabPlacement`**: `left` (sidebar tabs) or `top` (horizontal tabs) for
  composition tab rows; omit to auto-pick (left when there is one tab row, top
  when there are two or more).
- **`editor.native`** — which editor panels appear (`blockEditor: false` switches
  to the classic screen; `featuredImage: false` removes featured-image support
  on that template). After you change **Page →
  Template**, **Update** the page and reload the edit screen so PHP can apply the
  manifest (editor mode, ACF, locks).
- **`composition`** — ordered rows:
  - **partial** — `{ "id", "partial" }` is a reusable slice. Scaffolded PHP
    calls `( new Class( wonder_partial_props( 'slug', 'id' ) ) )->render()`.
    It also maps to an ACF group (partial manifest properties).
  - **fields** — `{ "id", "label"?, "properties": [ … ] }` editor-only ACF group
    using the same property types as partial manifests (`string`, `boolean`, `image`,
    `link`, `repeater`, …). Write the HTML in the page PHP; read values with
    `wonder_template_composition_field( 'your-id' )` (or `get_field( 'your-id' )`).
  - **tab** — `{ "id", "label", "items": [ …partial or fields rows… ] }` (ACF tabs).
  Instance ids must be unique across the whole tree. Tab rows register as ACF tabs;
  set `editor.acf.tabPlacement` to force **left** or **top**, or omit for the default.
  Save manifests under `.wonderpress/manifest/page-templates/` (strict JSON).

Manifest files must be **strict JSON** (no `//` comments or trailing commas). A
parse error skips the whole file, and partials fall back to per-slug ACF groups
from `wonderpress_template_fields` — which can look like fields “went global.”

When `composition` lists ACF-compatible partials, core registers **one** field
group on that page template; each instance id is an ACF group field name. Hydrate
with `wonder_partial_props( 'landing-hero', 'hero-main' )` in the page PHP (the
create scaffold emits those calls for `--section` rows). `wonder_render_template_sections()`
still exists for a page that is only named partials; do not mix it with handwritten
renders.

Assign the page to that template in the editor (**Page** → **Template** → your
template, then **Update**). Manifest rules apply only to pages whose saved
`_wp_page_template` matches the manifest `template` value (e.g.
`template-landing.php`). Pages on the default template keep the normal block
editor.

Seed sections at create time:

```bash
wonderpress template create --name Landing --lock all \
  --section hero-main:landing-hero --section quotes:testimonials
```

## 6. Build a component

```bash
wonderpress partial create --name Pull_Quote --block --prop "quote:string:required" --prop "attribution:string"
```

A **partial** is the unit of markup — a PHP class plus a view template. `--block`
also exposes it in the editor; leave it off for partials you only compose from
other partials, which is most of them.

Declared properties arrive in the view as plain local variables:

```php
<blockquote class="pull-quote">
	<p><?php echo esc_html( $quote ); ?></p>
	<?php if ( ! empty( $attribution ) ) : ?>
		<cite><?php echo esc_html( $attribution ); ?></cite>
	<?php endif; ?>
</blockquote>
```

`wonderpress partial list` shows everything the CLI has made, and flags any
block it did not write as `(no manifest)` — WordPress registers those too, but
the CLI cannot manage or remove them.

## 7. Check it in the editor

Open any page and insert your block. You should see:

- the block in the inserter, under a category named after your project
- **the block's actual design**, not a grey placeholder

If you get a placeholder, the editor script did not load — check that the
theme's `vendor/` directory exists and that the browser console is clean. The preview works by asking WordPress to render the block over REST, so
the PHP partial stays the only source of markup.

## Known rough edges

- **Type and spacing tokens are not connected** to Static Kit. Colour is.
- **Blocks have no inner content.** They render from the partial and take their
  values from the sidebar; a client cannot type directly into one.
  ServerSideRender's HTML is inert, so live React InnerBlocks cannot occupy a
  slot inside that PHP shell without duplicating markup. This is deferred by
  design, not an unfinished flag.
- **A theme switch takes the blocks with it.** wonderpress-core registers the
  blocks in the *active* theme's `blocks/` directory, so switching themes leaves
  already-published block content rendering as its raw HTML fallback. That is
  ordinary WordPress behaviour for theme-provided blocks, but it is worth
  knowing before you switch a live site.

## 8. Agents

`wonderpress init` writes `AGENTS.md` at the environment root (and a one-line
`CLAUDE.md` that points at it), and upserts the MCP stdio server into
`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, and `.codex/config.toml`.
Those MCP files are gitignored — they pin this machine's Node and CLI path.
`AGENTS.md` and `CLAUDE.md` are committed. Refresh with
`wonderpress agents write` after you invent components by hand; `partial create`
/ `sync` and `template create` already regenerate it.

`--format json` on list, check-drift, lint, and version prints
`{ "ok", "data", "error" }` on stdout and nothing else. Exit `0` / `1` / `2`.

Open the environment root in Cursor (or Claude Code / VS Code / Codex). Enable
the `wonderpress` MCP server if the host asks. Generated MCP config pins
`process.execPath` (the Node that ran `agents write` / `init`), the absolute
CLI `bin/wonderpress.js`, and `cwd` set to that environment root — so the host
does not substitute its own Node. Install with a native Node for your machine
(`process.arch` should match the CPU).

Once that entry exists, `agents write` leaves it alone. Hosts tie their "trust
this server" approval to the config contents, so rewriting a working entry
makes you approve it again. Re-run with `--force` after changing Node versions
or moving the checkout, then re-approve once. The first write prints a Cursor
install deeplink; Claude Code approves when you run `claude`; Codex after you
trust the folder.

`wonderpress mcp help` lists the tools.
Removes require `confirm: true`. `lint_theme` with `fix: true` runs phpcbf
(CLI `--fix`); it does not need confirm and does not repair drift
(`partial_sync`). `init`, `destroy`, and `server` are not tools.

## Upgrading wonderpress-core

wonderpress-core is a Composer dependency of the theme, declared in
`wp-content/themes/<theme>/composer.json` and pinned by the lock file beside it.
Both the lock file and `vendor/` are committed, so a deploy needs no Composer
step and a checkout is reproducible without one.

To take a new core:

```bash
cd wp-content/themes/<theme>
composer update wndrfl/wonderpress-core
```

Commit the resulting `composer.lock` and `vendor/` changes. Nothing needs to be
installed into `wp-content/mu-plugins`, and nothing needs a CLI bump.

### Upgrading a site that predates 2.0.0

Sites scaffolded before 2.0.0 carry core in `wp-content/mu-plugins/`. WordPress
loads mu-plugins long before any theme, so on those sites the old copy always
wins — the theme's newer copy stands down, because by then the old one has
declared its functions and PHP cannot redeclare them.

That matters more than it sounds. The 2.0.0 theme no longer carries the asset
pipeline or the baseline theme supports itself; it expects the package to
provide them. An old copy winning therefore means no compiled CSS or JS and no
supports — a site that breaks quietly, in a place nobody would think to look.

So core detects it and says so: when the copy that won is older than the one
that stood down, an admin notice names both versions and the path to delete.

**To migrate a site, delete `wp-content/mu-plugins/wonderpress-core*`.** There
is nothing to move — the theme already carries its own copy in `vendor/`.

## Testing changes to the toolkit itself

Four steps, and each one catches a class of problem the others cannot. Skipping
the third is how 2.7.0 shipped broken.

| | Step | Catches |
|---|---|---|
| 1 | `npm link`, iterate | logic and UX, fast |
| 2 | override the core ref, if core changed | core and CLI working together |
| 3 | `npm install -g "$(npm pack \| tail -1)"` | **packaging** — what a user actually receives |
| 4 | publish, reinstall, use it for real | everything else |

Step 3 is the one people skip, because steps 1 and 2 were green and it feels
redundant. It is not testing your code — it is testing the *parcel*. `files` in
package.json, a path that only resolved because of where you were standing, a
fix that never left your working tree.

Step 4 is not ceremony either. Almost everything found in this toolkit's first
week of real use — blocks erroring the moment they were inserted, `init` never
saying where the site was, no way to tear an environment down — was invisible to
all three steps above it, because nothing was *broken*. The tool simply did not
say something it knew.

**Before trusting any of it**, check what you are actually running:

```bash
which wonderpress && wonderpress version && npm ls -g @wndrfl/wonderpress-cli
```

A linked install shows an `->` and a path. Believing you are testing a release
while still linked is the quiet version of every problem on this page.

### Iterating on the CLI

```bash
cd wonderpress-cli && npm link
```

`wonderpress` anywhere now runs your working tree, uncommitted changes and all.
Undo it with `npm rm -g @wndrfl/wonderpress-cli`, then reinstall the published
one when you want to be a user again.

### Iterating on wonderpress-core

`init` resolves core through the theme's Composer manifest, so a core change is
invisible to a new project until someone tags it. That would make every
experiment a release, so the source is overridable:

```bash
WONDERPRESS_CORE_REPO=../wonderpress-core wonderpress init --dir ~/tmp/probe --env wp-env
```

A local path becomes a Composer `path` repository, which Composer symlinks —
so edits in your checkout show up in the site with no reinstall. A URL becomes
a `vcs` repository instead, and `WONDERPRESS_CORE_REF` sets the constraint
(`dev-my-branch` for a branch). Either half works alone.

> **The editor preview does not work against a symlinked checkout outside
> `wp-content`.** PHP resolves symlinks in `__FILE__`, so core sees its real
> location, and a file outside `wp-content` has no URL a browser can fetch —
> core declines to enqueue the preview script rather than emit a 404. Blocks
> still register server-side; they just will not render in the editor.
>
> If you need the editor while iterating, either keep the checkout inside
> `wp-content`, or tell Composer to copy instead of symlink:
>
> ```bash
> composer config repositories.wonderpress-core '{"type":"path","url":"../../../../wonderpress-core","options":{"symlink":false}}'
> ```
>
> A copy means re-running `composer update` after each core edit.

It warns every time, and records the version Composer actually resolved in
`.wonderpressrc`, read back out of the lock file rather than restated — so a
project built this way never claims to be running a released version.

To point an *existing* project at a checkout, skip the environment variables
and do it directly, which is all the CLI does on your behalf:

```bash
cd wp-content/themes/<theme>
composer config repositories.wonderpress-core path ../../../../wonderpress-core
composer require wndrfl/wonderpress-core:*@dev
```

### Before publishing

`npm link` tests your working tree, which is *not* what a user gets. The gap
between them is real: 2.7.0 went out having been hand-tested green, because
everything had been verified against a local checkout while npm carried
something older.

So check the artifact, not the tree:

```bash
cd wonderpress-cli && npm install -g "$(npm pack | tail -1)"
```

That installs exactly what would be published — `files` in package.json, and
nothing that happens to be lying around your working directory.

### Testing the CLI's own behaviour

`wonderpress-cli/sandbox/` builds a throwaway environment against the **local**
checkout. Good for the development loop; useless for verifying a release, for
the reason above.
