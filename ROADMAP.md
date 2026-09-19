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
| 0 — Re-home the plumbing | **Mostly done** — one item left (Vite) |
| 1 — Formalize core + contract | **Mostly done** — one item left (core as a versioned package) |
| 2 — Fire the spine + constrain the editor | **Mostly done** — theme.json, wrapper attributes and the curated suite shipped; the page lock dial is left |
| 2b — Editor JavaScript | In progress — buildless editor-preview; Tier B rollout (`image`, `link` done) |
| 3 — The AI layer | Not started |
| 4 — Optional Figma | Not started |

Last verified: 2026-09-15, against CLI 2.6.0 / Static Kit 2.13.0.
Phase 2 re-scoped 2026-09-14: block theme → hybrid theme.
Lock dial split into page-lock and block-lock 2026-09-15.

---

## Phase 0 — Re-home the plumbing

| Item | State |
|---|---|
| Node LTS + native ESM (drop the `esm` shim) | ✅ Node >=24, `"type": "module"` |
| WPCS 2.x → 3.x | ✅ in wonderpress-core |
| Static Kit version fragmentation | ✅ lockstep releases, floor `^2.13.0` |
| Local environment → wp-env / DDEV | ✅ **CLI 2.6.0** — `init --env wp-env`, opt-in |
| Static Kit engine → Vite | ❌ still esbuild + sass directly |

**Remaining: Vite.** Deferred on the rule "re-home it when something forces the
question, not before" — the forcing function being `edit.js` / editor bundles.
**As of Sep 2026 that has arrived**: visual fidelity in the editor requires an
editor bundle (Phase 2b), and that bundle is a genuinely different job from
Static Kit's site bundles — it resolves `@wordpress/*` against WordPress's own
script registry as externals. Settle Vite deliberately as part of that arc
rather than bolting another esbuild invocation on.

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

## Phase 2 — Fire the spine, ship the slate

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

### Constraining the editor ⚠️ — mostly shipped, one piece left

The shipped theme was a classic PHP theme emitting blocks into an editor we had
never constrained. As of Sep 2026 it has a constrained `theme.json`, blocks that
carry their wrapper attributes, blocks published under the **project's**
namespace rather than WonderPress's, and an opt-in curated suite. **The page
lock dial is what remains.**

> **Superseded, Sep 2026.** This arc was framed as "the slate": `theme.json`
> *plus* `templates/` *plus* `parts/` — becoming a block theme, on the premise
> that we could "adopt the block theme file format and refuse the Site Editor
> workflow." Those turn out not to be cleanly separable, and the framing is
> withdrawn. See [docs/hybrid-theme-plan.md](docs/hybrid-theme-plan.md).

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
- **The curated suite** — ✅ **Shipped**, wonderpress-core#7. Opt-in via
  `WONDERPRESS_CURATE_BLOCKS`; 117 blocks become 6. The list comes from what
  core actually registered, **not** from the manifests as originally planned:
  the manifest indexes partials, the allowed list wants blocks, and core already
  has them. That also keeps hand-written blocks working, which a
  manifest-derived list would have left registered but un-insertable.
- **The lock dial** — two dials, not one. *Page* lock (can this page be composed
  at all) is a fact about the page and rides on the page template, via
  `block_editor_settings_all`: `'all'` for code-rendered pages, `'contentOnly'`
  for client-editable content in a frozen layout (the sweet spot most agencies
  skip), `false` for open composition. *Block* lock (can this block's inner
  content be rearranged) is a fact about the component and rides in the
  manifest — but it governs `InnerBlocks`, which our blocks do not yet have, so
  it waits on Phase 2b. The earlier framing put the page decision in the
  component manifest; a page has one lock level and its components would each
  claim one, with no rule to resolve the conflict.
- **Wrapper attributes** — `render.php` must emit
  `get_block_wrapper_attributes()`, or our blocks carry no standard block class
  and any support we ever enable is inert.

`templates/` and `parts/` are **dropped, not deferred**. The burden of proof is
on anything that wants to reintroduce them.

**Why the environment work came first:** none of this can be verified by
asserting on emitted files. "Does `contentOnly` actually freeze layout" is
load-and-click work, so this arc's cost is dominated by manual verification
cycles. `./sandbox/bootstrap.sh --env wp-env --fresh` is now the loop.

### Editor JavaScript ❌ — newly forced

A block registered only on the server has **no editor preview**: the client sees
a placeholder, not the design. So "be as visual as possible in the editor, while
still supporting full bespoke" cannot be met by the arc above, and it ends the
"no `edit.js`, no editor bundle" deferral that the block work took on
deliberately.

The approach — `ServerSideRender` for an accurate preview, locked `InnerBlocks`
for in-place text editing, neither of which duplicates the partial's markup — is
planned in [docs/editor-js-plan.md](docs/editor-js-plan.md). This is also the
thing that forces the Vite question in Phase 0.

### Correctness primitives ⚠️ — seeded, not built

`wonderpress-core` has `link` and `image`, but they predate the brief and do not
meet its bar (`image` has no `loading`/`decoding`).

"Unopinionated" spans three axes and conflating them is the trap: **aesthetics**
→ ship nothing. **Architecture** → ship structure. **Correctness (a11y,
performance, semantics)** → not a matter of opinion at all. There is one right
answer and everything else is a bug. Ship it.

A primitive must pass all three tests: one correct implementation that is
project-invariant; zero visual opinion; and removing it would make every project
re-derive the same correctness and some would get it wrong.

Candidate set, small and boring on purpose: link, button, form inputs, `img`
(dimensions reserved → no CLS, `loading`/`decoding`, responsive srcset),
dialog/disclosure behavior, visually-hidden, skip-link, heading-level manager,
icon wrapper. "Card" or "Hero" have crossed into opinion — those are components,
generate them.

**Build these before Phase 3.** The argument for primitives is that an agent
cannot ship an inaccessible button because the only button that exists is the
correct one. That guardrail has to exist before the agent does.

---

## Phase 3 — The AI layer

Not started. Wrap the deterministic operations as an MCP server; ship a
`CLAUDE.md` generated from conventions + manifests; grow `lint` with an axe
(a11y) pass and a Static Kit performance budget so standards are enforced rather
than merely available.

The division that makes this work: **one right answer → deterministic op.
Judgment → agent.** The CLI is the API and the agent is one of two clients
driving it — never two codebases. It degrades gracefully: no agent, agent
offline, or a junior dev who does not trust it yet, and the CLI still works.

The flag-driven refactor (Phase 1) was the hinge this turns on, and it is done.

---

## Phase 4 — Optional Figma

Not started. **Tokens first** (Figma variables ↔ `theme.json`) — stable,
structured, high-ROI, and it feeds the slate directly. Component-level Code
Connect is the second, more advanced move, behind an opt-in flag.

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

**Platform boundary:** WordPress when an integrated CMS with WYSIWYG fidelity for
non-technical clients is the point. Sanity when structured content with a custom
front end is the point.

---

## Recommended order

1. **`theme.json`** (Phase 2) — cheap, reversible, and an immediate win on the
   core blocks clients actually use. It cannot break "classic-capable," because
   it does not change the theme's type.
2. **Wrapper attributes in `render.php`** — small, self-contained, and it
   unblocks everything downstream.
3. **The curated suite and the lock dial** — the pieces that make the editor
   ours rather than WordPress's.
4. **Correctness primitives** into `[core]` — small, boring, high leverage, and
   the guardrail Phase 3 depends on.
5. ~~**Package wonderpress-core**~~ ✅ done — it is a Composer dependency of the
   theme now, so `[core]` and `[base]` version together through one lock file.
6. **Editor JavaScript** (Phase 2b) — the large one, and the one that takes the
   Vite question with it.
7. **Phase 3**, then Phase 4.

The wp-env default flip stays opportunistic: take it when something forces the
question.
