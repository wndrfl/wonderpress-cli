# Property value shapes

Normative wire formats for manifest property types. Dual partials (ACF + block)
must produce the **same canonical value** on flat partial properties after
construction. See [dual-authorable-types.md](dual-authorable-types.md) for the
platform rule and tier rollout.

Status: Tier A implemented. Tier B specified here; block controls and PHP
normalization are backlog.

## Hydration pipeline

Partials should read **flat properties** (`$title`, `$photo`, …). Views must not
branch on whether data came from ACF or from a block.

| Path | Today | Target (Tier B) |
| --- | --- | --- |
| **ACF** | `wonder_partial_props()` → `{ acf: get_field( … ) }` → `attempt_acf_ingestion()` copies keys onto flat props | Unchanged |
| **Block** | `new Partial( $attributes )` assigns flat keys from block JSON | Structured attributes **normalized** to the same shapes ACF ingestion produces |

Planned hook (not implemented yet):

`wonder_normalize_property_value( string $type, mixed $value, array $prop_def ): mixed`

Call from block render or `Abstract_Partial` when hydrating from attributes.

## Global conventions

- **JSON-safe block storage:** no `WP_Post`, no PHP resources — IDs and plain arrays/objects only.
- **Empty values:** document per type; required-field validation stays in `Abstract_Partial::render()`.
- **Manifest `acf` passthrough:** affects ACF UI and ACF return format only. **Block wire format is fixed** per type below unless this doc says otherwise.
- **`when`:** authoring-only (hide inspector fields; saved values retained — ACF parity).
- **Repeater depth:** one level only (no repeater sub-fields of type `repeater`).

## Tier A (dual today)

| Type | PHP property value | Block attribute |
| --- | --- | --- |
| `string` | `string` | `string` |
| `boolean` | `bool` | `boolean` |
| `email` | `string` | `string` |
| `select` | `string` (choice **key**) | `string` (+ `enum` in `block.json` when `choices` are static) |

## Tier B — `image`

**ACF mapping:** image field, `return_format: array` (wonderpress-core `acf.php`).

**Canonical wire (block + normalized ACF):** associative array aligned with ACF
image array.

| Key | Type | Required for templates |
| --- | --- | --- |
| `ID` | int | yes |
| `url` | string | yes |
| `alt` | string | recommended |
| `width`, `height` | int/string | recommended |
| `sizes` | object/map | recommended when using core `Image` partial sizes |

**Block storage:** one `object` attribute. After media pick, store the canonical
array (expand attachment ID via REST/`wp.media` — do not leave bare ID on the
partial property unless normalization always expands).

**Future editor:** `MediaUpload` + schema in `wonderpressBlockSchemas`.

**Acceptance:** add `image` to `DUAL_AUTHORABLE_TYPES` when editor + normalize ship.

## Tier B — `link` (simple manifest type)

This is **`type: "link"`** on a property — a fixed four-field group in ACF. It
is **not** the rich Link primitive (`partial: "link"`); see [Deferred profiles](#deferred-profiles).

**ACF mapping:** group with sub-fields `content`, `url`, `open_in_new_tab`, `title`.

**Canonical wire:** one object with exactly those keys:

```json
{
  "content": "Read more",
  "url": "https://example.com",
  "open_in_new_tab": true,
  "title": "Read more about us"
}
```

| Key | Type |
| --- | --- |
| `content` | string |
| `url` | string |
| `open_in_new_tab` | bool |
| `title` | string |

**Block storage:** single `object` attribute (matches ACF group and `phpFormatForType( 'link' )` → array).

**Future editor:** `LinkControl` and/or four inspector fields mapped into this object.

**Acceptance:** add `link` to `DUAL_AUTHORABLE_TYPES` when editor ships.

## Tier B — `post_object`

**ACF mapping:** `post_object`; default `return_format: object` unless manifest
`acf.return_format` overrides. `post_type` from manifest `acf.post_type`.

**Canonical wire on the flat partial property:** **`int` post ID or `null`**
(recommended for dual partials and simple templates).

**ACF path (target normalization):** when ACF returns `WP_Post` or an array
with `ID`, reduce to int before assigning the flat property.

**Block storage:** `object` attribute in `block.json` today; store **`{ "ID": 123 }`**
(or normalize to int on the flat prop at construct time). Multi-select
(`acf.multiple`) is **v2** — not in Tier B unless spec is extended.

**Future editor:** post picker filtered by `acf.post_type` from block schema.

**Acceptance:** picker + ID normalization on flat prop.

## Tier B — `repeater`

**ACF mapping:** repeater; sub-fields from manifest `properties` / CLI `--sub`.

**Canonical wire:** JSON **array** of **row objects**. Each row is keyed by
sub-property `name`; values follow that sub-type’s spec in this document
(recursive). Sub-types allowed: `boolean`, `email`, `image`, `link`, `partial`,
`select`, `string` (`REPEATER_SUB_TYPES`).

**Empty:** `[]`.

**Block storage:** `array` attribute.

**Future editor:** add/remove rows; nested controls reuse per-type editors.

**Acceptance:** repeater UI + every nested sub-type dual-authorable.

## Tier B — `partial` (embed)

**ACF mapping:** group; sub-fields from referenced partial manifest
(`prop.partial` slug).

**Canonical wire:** object keyed by the **referenced manifest’s property names**;
nested values follow those types’ specs (recursive).

**Theme rendering:** `wonder_render_partial_ref( $slug, $value )` passes `$value`
as `{ acf: $value }` to core primitives (Link, Image). Theme views may read the
nested object directly or delegate render.

**Block storage:** `object` attribute.

**Future editor:** recursive inspector; server may embed referenced manifests in
`wonderpressBlockSchemas` for linked slugs.

**Acceptance:** recursive UI + [transitive dual rule](#transitive-dual-exposure).

## Transitive dual exposure

When a dual partial declares `type: partial`, **every property on the referenced
manifest** must be dual-authorable (transitive closure). Future CLI lint beyond
flat `assertDualAuthorable()`.

## Rollout checklist

Add types to `DUAL_AUTHORABLE_TYPES` in `validate.js` only after spec acceptance:

| Order | Type | Requires |
| --- | --- | --- |
| 1 | `image` | MediaUpload + ID→array normalize |
| 2 | `link` | Simple link object editor |
| 3 | `post_object` | Post picker + ID normalize |
| 4 | `repeater` | Row UI + nested type coverage |
| 5 | `partial` | Recursive schema/UI + transitive lint |

Editor work tracks [editor-js-plan.md](editor-js-plan.md) and [ROADMAP.md](../ROADMAP.md) Phase 2b.

## Deferred profiles

### Rich Link primitive (`partial: "link"`)

Core [`manifest/partials/link.json`](../../wonderpress-core/wonderpress-core/manifest/partials/link.json)
(type switch, internal/file/email/telephone targets, query params, etc.) is a
**separate profile**. Composition and embeds use `wonder_render_partial_ref()` with
`{ acf: … }`. **Dual block authoring for this profile is not Tier B** — spec later
if a block needs the full primitive.

## Non-goals

- Nested repeaters
- Removed manifest types `array` / `object`
- Full ACF Pro field catalog
- Identical persistence (post meta vs block JSON in post content)
