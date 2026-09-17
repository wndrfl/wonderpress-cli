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
		'page-landing.php' => 'all',          // bespoke, code-rendered
		'default'          => 'contentOnly',  // text editable, layout frozen
	);
} );
```

`default` covers pages on no particular template. A template you do not name is
left exactly as WordPress configured it — absent is not the same as `false`, so
this cannot accidentally unlock something.

`contentOnly` is the interesting one and the one most agencies skip: the client
edits words, the layout does not move.

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

If you get a placeholder, the editor script did not load — check that
wonderpress-core is installed as an mu-plugin and that the browser console is
clean. The preview works by asking WordPress to render the block over REST, so
the PHP partial stays the only source of markup.

## Known rough edges

- **Type and spacing tokens are not connected** to Static Kit. Colour is.
- **Blocks have no inner content.** They render from the partial and take their
  values from the sidebar; a client cannot type directly into one. Locking a
  block's *inner* structure therefore has nothing to act on yet.
- **wonderpress-core is installed from a pinned git tag**, not a Composer
  package. `.wonderpressrc` records which version a project got. Upgrading means
  bumping the CLI.
