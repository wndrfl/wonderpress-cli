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
| 2 — Fire the spine + ship the slate | **Half done** — the spine fires; the slate does not exist |
| 3 — The AI layer | Not started |
| 4 — Optional Figma | Not started |

Last verified: 2026-09-14, against CLI 2.6.0 / Static Kit 2.13.0.

---

## Phase 0 — Re-home the plumbing

| Item | State |
|---|---|
| Node LTS + native ESM (drop the `esm` shim) | ✅ Node >=24, `"type": "module"` |
| WPCS 2.x → 3.x | ✅ in wonderpress-core |
| Static Kit version fragmentation | ✅ lockstep releases, floor `^2.13.0` |
| Local environment → wp-env / DDEV | ✅ **CLI 2.6.0** — `init --env wp-env`, opt-in |
| Static Kit engine → Vite | ❌ still esbuild + sass directly |

**Remaining: Vite.** Deliberately deferred. It buys maintenance posture rather
than capability, and the moment it actually pays off is when we take on
`edit.js` / editor bundles — which the block work explicitly left to a later
arc. Re-home it when that question forces it, not before.

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
| wonderpress-core as a *versioned* package | ❌ installed by `git clone` of master |

**Remaining: package wonderpress-core properly.** It is central IP installed via
`git clone` ([src/core.js](src/core.js), `installMuPlugin`) with no version
contract, and it has commits past its last tag. Make it a Composer dependency
and tag it. This matters more once `[base]` starts changing alongside it — which
is exactly what Phase 2 does.

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

### The slate does not exist ❌ — this is the next arc

The shipped theme is still a classic PHP theme. There is **no `theme.json`, no
`templates/`, no `parts/`, no lock dial**. We emit blocks into a theme that is
not block-first, so the brief's headline claim is currently half true.

What it needs:

- **`theme.json`, constrained not empty.** An empty one is *permissive* — any
  color, any size — and makes WP emit a bloated global-styles blob. Define token
  slots and switch off freeform choices, so everything routes through tokens.
  Unopinionated about what the brand is; opinionated that it arrives via tokens.
- **Block templates as files** — `index/single/page/archive/404/search`, present
  but empty. WordPress requires them; shipping them empty is structure, shipping
  them styled would be opinion. The line is exactly there.
- **`parts/`** — header and footer, structural only.
- **The lock dial** — `templateLock: 'all'` for bespoke code-rendered pages,
  `'contentOnly'` for client-editable content in a frozen layout (the sweet spot
  most agencies skip), `false` for open composition. The default lock level
  rides in the component manifest, so editability is set at the contract rather
  than rediscovered per page.

**Adopt the block theme file format; refuse the Site Editor workflow.** Templates
are authored as files and reviewed in PRs. Editing templates by clicking in
wp-admin is page-builder-adjacent and violates "code is the source of truth."
Those two things are separable — take the format, refuse the workflow.

**Why the environment work came first:** none of this can be verified by
asserting on emitted files. "Does `contentOnly` actually freeze layout" is
load-and-click work, so this arc's cost is dominated by manual verification
cycles. `./sandbox/bootstrap.sh --env wp-env --fresh` is now the loop.

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

1. **The slate** (Phase 2) — the gap that makes "block-first, classic-capable"
   true, and the direct sequel to the block work already shipped.
2. **Correctness primitives** into `[core]` — small, boring, high leverage, and
   the guardrail Phase 3 depends on.
3. **Package wonderpress-core** — best done alongside the slate, since that arc
   changes `[core]` and `[base]` together and drift is the named risk.
4. **Phase 3**, then Phase 4.

Vite and the wp-env default flip are opportunistic: take them when something
forces the question.
