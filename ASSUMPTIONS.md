# XML Generation Assumptions

## 1. Element Occurrence

Every element is always generated exactly once, regardless of `minOccurs` or `maxOccurs`. The code has `const isRequired = true` hardcoded — so even `minOccurs="0"` optional elements are included, and `maxOccurs="unbounded"` elements only get one instance.

## 2. Default Values (priority order)

For any element's text value:

1. `fixed` attribute from XSD (always wins)
2. `default` attribute from XSD
3. `FieldLevelDefaultValue` from sample JSON (by field name)
4. `DataTypeLevelDefaultValue` from sample JSON (by type)
5. Hardcoded type defaults in `getDefaultValue()`:
   - `string` → `''` (empty)
   - `int` / `integer` / `long` / `short` / … → `'0'`
   - `decimal` / `float` / `double` → `'0.0'`
   - `boolean` → `'false'`
   - `dateTime` → `'2024-01-01T00:00:00'`
   - `date` → `'2024-01-01'`
   - `time` → `'00:00:00'`
   - `NMTOKENS` / `token` / `normalizedString` / `anyURI` / … → `''` (empty)
6. Element name itself as last resort (for simple XS types only)

Type names without a namespace prefix (e.g. `int`, `decimal`) are also recognised as XSD built-in types when the schema declares `xmlns="http://www.w3.org/2001/XMLSchema"` as its default namespace.

## 3. Enumerations

For `xs:restriction` with `xs:enumeration`, always picks the **first** enumeration value. No other values are considered. `FieldLevelDefaultValue` can override this.

## 4. xs:choice

- Always picks only the **first branch** of a `<xs:choice>`. Other branches are ignored entirely.
- A choice is included if `minOccurs >= 1` or `maxOccurs > 1`.

## 5. Attributes

| `use` value | Behaviour |
|---|---|
| `required` | Always included with `fixed \|\| default \|\| getDefaultValue(type)` |
| `optional` with a `default` | Included with the default value |
| `optional` with no default | Omitted entirely |
| `prohibited` | Not explicitly handled; treated the same as optional |

## 6. xs:union

Uses the **first member type** only (`memberTypes` is split on whitespace, first entry used for `getDefaultValue()`). The union variant is not considered.

## 7. xs:list

Always produces an **empty string** — no list items are generated.

## 8. xs:group references

Not supported — emits a `[WARN]` and skips the group. Nothing is generated for that content.

## 9. xs:any

Skipped silently — no content is generated for `xs:any` wildcards.

## 10. Root element selection

The **first** `xs:element` defined at the schema's global level in that specific XSD file is used as the root. If none is found, falls back to `<Root/>`.

Multiple XSD files declaring a global element with the same name do not conflict — each file uses its own element node directly (not the shared `globalElements` map), so the correct root is always selected.

## 11. Included/Imported schemas

- `xs:include` and `xs:import` are resolved **locally only** (relative to the XSD file). Remote URLs are only fetched if `--fetch-remote` is passed; otherwise they are silently skipped.
- The type model is global — if two included XSDs define a **named type** (`complexType`, `simpleType`) with the same name, the last one processed (in topological order) wins.

## 12. Namespace handling

The **root file's** `elementFormDefault` determines the namespace style for the entire generated document.

### Qualified root (`elementFormDefault="qualified"` on the root XSD file)

- Root element declares a **default namespace**: `<RootElem xmlns="targetNamespace" …>`.
- No element in the document carries an explicit prefix — all elements (root, children, and global refs) are covered by the inherited default namespace.

### Unqualified root (`elementFormDefault="unqualified"`, or not set — the default)

- Root element declares a **prefixed namespace**: `<ns0:RootElem xmlns:ns0="targetNamespace" …>`.
- Elements that require namespace qualification get the `ns0:` prefix:
  - The root element itself.
  - Global element references (`ref="…"`), always.
  - Local elements declared in an **included** file whose own `elementFormDefault` is `qualified`.
- Local elements declared in an unqualified file carry no prefix.

### No `targetNamespace`

- No namespace declarations or prefixes are emitted on any element.

### Imported namespaces

- Each distinct imported namespace gets an auto-generated prefix (`ns1`, `ns2`, …) declared on the root element, regardless of the root's `elementFormDefault`.

## 13. Pipeline validation vs. server validation

The pipeline validates the **generated XML file** (`output/…/*.xml`) against the source XSD immediately after generation. The validation server validates whatever **Postman sends as the request body**, which comes from the `.request.yaml` files written to `postman/collections/`.

These two are only guaranteed to agree **after Postman refreshes its Local View** following a pipeline run. Until then, Postman may send stale XML from a previous generation while the server validates against the updated XSD — causing the server to reject XML that the pipeline accepted.

**Practical rule**: if you change an XSD (especially `elementFormDefault`, `targetNamespace`, or element structure) and re-run the pipeline, always trigger a Postman Local View refresh before sending requests.

## 14. Encoding

- Input XSD files: UTF-16 LE/BE (BOM-detected) and UTF-8 are all handled.
- Output XML is always written as **UTF-8**.
