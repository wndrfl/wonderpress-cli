# Dual-authorable property types

Status: Tier A shipped (scalars). Tier B (structured types) is backlog.

## Rule

If a property type is allowed in partial manifests **and** a partial is **dual**
(`acf_compatible` plus a block wrapper), that type must be authorable in **both**
ACF and the block editor, with the **same semantic value** reaching the PHP
partial (flat properties after construction).

This is a **type-system** guarantee. It does not require every partial to be dual.

## Tiers

| Tier | Types | Dual partials |
| --- | --- | --- |
| **A** | `string`, `boolean`, `email`, `select` | Allowed today |
| **B** | `image`, `link`, `repeater`, `partial`, `post_object` | Block inspector work pending; CLI rejects `--acf` + `--block` until Tier B ships |
| **Removed** | `array`, `object` | Use explicit primitives, `repeater`, or `partial` embeds instead |

## Value shape (Tier A)

- Block path: flat attributes on `new Partial( $attributes )`.
- ACF path: `wonder_partial_props()` → `{ acf: get_field( … ) }` → flat props via ingestion.
- Stored values are strings or booleans matching ACF return values.

## Placement

Do not locate an ACF field group for a partial on screens where editors also insert
that partial as a block (duplicate Hero UI). See [getting-started.md](getting-started.md).

## Block editor schema

`block.json` only stores WordPress attribute types (`string`, `boolean`, `object`, …).
WonderPress passes manifest property definitions to the editor as
`window.wonderpressBlockSchemas` so controls match ACF semantics (`select`, `email`,
textarea heuristics, `when` conditionals).

## Tier B backlog

See [editor-js-plan.md](editor-js-plan.md) and [ROADMAP.md](../ROADMAP.md) Phase 2b:
media, link, repeater, nested partial embeds, post object picker, and PHP
normalization so block JSON matches ACF array shapes.
