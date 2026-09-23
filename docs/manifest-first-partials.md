# Manifest-first partials

WonderPress partial **fields** are defined in JSON, not in the PHP class. ACF and the block editor read `.wonderpress/manifest/partials/*.json` at runtime. The theme partial class and `block.json` are **generated** from that contract.

## Where to edit

| Safe to edit (PHP-first OK) | Edit manifest, then sync |
| --- | --- |
| `partials/*.php` view templates | `.wonderpress/manifest/partials/<slug>.json` |
| SCSS / JS behavior stubs (`partial add-js` scaffolds JS later; sync does not) | `src/partials/class-*.php` (`$_properties`) |
| Helpers, services, custom PHP outside generated class | `blocks/<slug>/block.json` attributes |

Do **not** add new fields by editing `$_properties` or `block.json` by hand — they will drift and `partial sync` will overwrite the class.

## Workflow

1. Edit the partial manifest (properties, types, labels, repeaters, embeds).
2. Regenerate derived files:

```bash
wonderpress partial sync Hero
# or every partial:
wonderpress partial sync --all
```

3. Reload the block editor; re-save a page if ACF field groups changed shape.

Preview without writing:

```bash
wonderpress partial sync Hero --dry-run
```

## CI / pre-merge check

From the theme directory (with WonderPress env root as cwd):

```bash
wonderpress partial check-drift --all
```

Exits non-zero when the class or `block.json` does not match the manifest. Fix with `partial sync` or revert hand-edits to generated files.

## Optional pre-commit (theme)

Example [husky](https://typicode.github.io/husky/) hook when manifests or generated paths change:

```bash
#!/bin/sh
# .husky/pre-commit — adjust paths to your theme root
changed=$(git diff --cached --name-only)
echo "$changed" | grep -qE '\.wonderpress/manifest/partials/|src/partials/class-|blocks/.+/block\.json' || exit 0
wonderpress partial check-drift --all || {
  echo "Partial drift: run wonderpress partial sync <Name> or revert generated files."
  exit 1
}
```

## Related

- [property-value-shapes.md](property-value-shapes.md) — wire formats and dual types
- [dual-authorable-types.md](dual-authorable-types.md) — ACF + block partials
- Jira WNDRPRS-17 — guardrails; optional `partial watch` deferred
