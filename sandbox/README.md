# WonderPress Sandbox

A disposable WordPress environment for trying the CLI by hand before shipping it.

Everything real lives in `wp/`, which is **git-ignored and meant to be destroyed**.
Break it freely — `./bootstrap.sh --fresh` builds a clean one in a few minutes.

## Two backends

The sandbox builds whichever local environment you want to test against.

| | host (default) | wp-env (`--env wp-env`) |
|---|---|---|
| WordPress + database | your machine | Docker containers |
| PHP | whatever you have | pinned 8.2 |
| Serving | `wp server`, port 8080 | already running, port 8888 |

## Requirements

**Both** backends need `node`, `wp` (WP-CLI), `php` and `composer` on PATH.
wp-env replaces MySQL, not the PHP toolchain — `wp core download` still runs on
the host, and composer still produces the `vendor/bin/phpcs` that
`wonderpress lint` uses.

- **host** also needs `mysql` running: `brew services start mysql`
- **wp-env** also needs Docker Desktop running, with the Compose v2 plugin

## Build it

```bash
./bootstrap.sh
```

| Command | What it does |
|---|---|
| `./bootstrap.sh` | Build `wp/` with the host backend (refuses if it already exists) |
| `./bootstrap.sh --env wp-env` | Build `wp/` with Docker instead |
| `./bootstrap.sh --fresh` | Tear down, then rebuild |
| `./bootstrap.sh --destroy` | Tear down and stop |

`--destroy` works out which backend is on disk rather than trusting the flag,
so you can tear down a Docker sandbox without remembering how you built it.
For wp-env it removes containers, volumes **and images**, so the next build
re-pulls — for a merely wedged database, `wp-env clean` is the cheaper hammer.

Defaults (host backend): database `wonderpress_sandbox`, site `localhost:8080`, login
`admin` / `sandbox`. Override by exporting `WP_DB_NAME`, `WP_SITE_URL`,
`WP_ADMIN_PASSWORD`, etc. before running.

## The point: you are testing local code, not npm

The script runs the CLI from the repo it lives in — your working tree, whatever
branch is checked out. It prints the branch and commit when it starts, so check
that line matches what you meant to test. Point it elsewhere with
`WONDERPRESS_CLI_DIR=/path/to/cli ./bootstrap.sh`.

To test the *published* CLI instead, `npm i -g @wndrfl/wonderpress-cli` and use
the `wonderpress` command rather than the alias below.

### Switching branches

`wp/` does not care which branch you are on — it is just a WordPress install.
To try a different branch's code against the environment you already have, check
it out and keep going; no rebuild:

```bash
git checkout feat/some-branch
```

`node_modules` is not tracked, so it survives the switch — the installed
dependencies stay put while you swap code around.

**The trap:** `./bootstrap.sh --fresh` runs `npm install`, which resets
`node_modules` to whatever *the current branch* pins. That is correct behaviour
— you should test a branch with its own declared dependencies — but it cuts both
ways. If you install a newer dependency on branch A and then rebuild on branch B,
the rebuild will quietly put the older one back, and a bug you just fixed
reappears. If that happens, check what the branch actually declares:

```bash
grep static-kit ../package.json
npm ls @wndrfl/static-kit-cli --prefix ..
```

Rebuild from scratch when testing `init` itself, or when a branch changes
dependencies. For everything else, a plain `git checkout` is enough.

## Use it

```bash
cd wp
alias wpd="node ../../bin/wonderpress.js"
```

Every command needs `--theme wonderpress` (it skips the database lookup for the
active theme).

```bash
wpd partial create --theme wonderpress --name Testimonial --js --prop quote:string:required
```

```bash
wpd partial list --theme wonderpress
```

```bash
wpd block create Testimonial --theme wonderpress
```

Run `wpd partial create --theme wonderpress` with no other flags for the
interactive wizard.

## What to poke at

The behaviour worth confirming by hand, because it is where the design decisions live:

**A partial is not a block.** `partial create` alone writes no `block.json`.
The block is opt-in, via `--block` at creation or `block create` later. Both
routes produce byte-identical output.

**A block cannot outlive its partial.** With a block in place, `partial remove`
refuses and tells you the way out. `block remove` is the safe demote — the
wrapper goes, the partial stays. `partial remove --with-block` removes both.

**Partial manifests are the index.** `.wonderpress/manifest/partials/<slug>.json` is what
`list` reads and what `remove` deletes by. Open one. Every path it advertises
should exist on disk — nothing is recorded that was not actually written.

**The style/JS half is delegated.** `--js` scaffolds
`static/src/js/lib/partials/<Name>.js`; the SCSS stub comes by default. Both are
written by Static Kit, not by WonderPress. Without `static/.staticrc` they are
skipped with a warning and, importantly, are then absent from the manifest.

## See it in a browser

**host backend** — start the server, Ctrl-C stops it:

```bash
cd wp && wp server
```

http://localhost:8080/wp-admin

**wp-env backend** — already serving, nothing to start:

http://localhost:8888/wp-admin

Either way, a partial created with `--block` shows up in the editor's inserter
under **WonderPress** (registered by wonderpress-core, which closes the
emit → consume loop). Under wp-env you can also assert it without clicking:

```bash
cd wp && ./node_modules/.bin/wp-env run cli wp eval \
  'var_dump( WP_Block_Type_Registry::get_instance()->is_registered("wonderpress/testimonial") );'
```

## When something goes wrong

A half-built `wp/` is not worth debugging — `./bootstrap.sh --fresh` and move on.

If the CLI behaves oddly right after a branch switch, its dependencies may be
stale; the bootstrap script runs `npm install` in the CLI directory for exactly
this reason, so re-running it is the fix.
