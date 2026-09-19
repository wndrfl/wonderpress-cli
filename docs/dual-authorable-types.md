# Dual-authorable property types

Status: Tier A shipped (scalars). Tier B (structured types) is specified; block
controls and normalization are backlog.

## Rule

If a property type is allowed in partial manifests **and** a partial is **dual**
(`acf_compatible` plus a block wrapper), that type must be authorable in **both**
ACF and the block editor, with the **same semantic value** reaching the PHP
partial (flat properties after construction).

This is a **type-system** guarantee. It does not require every partial to be dual.

**Wire formats:** [property-value-shapes.md](property-value-shapes.md) (normative).

## Tiers

| Tier | Types | Dual partials |
| --- | --- | --- |
| **A** | `string`, `boolean`, `email`, `select` | Allowed today |
| **A+** | `image`, `link` (simple) | Dual today (Phase 2b rollout #1–2) |
| **B** | `repeater`, `partial`, `post_object` | Specified; CLI rejects `--acf` + `--block` until each type meets rollout checklist |
| **Removed** | `array`, `object` | Use explicit primitives, `repeater`, or `partial` embeds instead |

## Value shape (Tier A)

- Block path: flat attributes on `new Partial( $attributes )`.
- ACF path: `wonder_partial_props()` → `{ acf: get_field( … ) }` → flat props via ingestion.
- Stored values are strings or booleans matching ACF return values.

Tier B canonical shapes (image array, link object, repeater rows, etc.) are in
[property-value-shapes.md](property-value-shapes.md).

## Placement

Do not locate an ACF field group for a partial on screens where editors also insert
that partial as a block (duplicate Hero UI). See [getting-started.md](getting-started.md).

## Block editor schema

`block.json` only stores WordPress attribute types (`string`, `boolean`, `object`, …).
WonderPress passes manifest property definitions to the editor as
`window.wonderpressBlockSchemas` so controls match ACF semantics (`select`, `email`,
textarea heuristics, `when` conditionals).

## Tier B rollout

See the checklist in [property-value-shapes.md](property-value-shapes.md#rollout-checklist).
Implementation: [editor-js-plan.md](editor-js-plan.md) and [ROADMAP.md](../ROADMAP.md) Phase 2b.
