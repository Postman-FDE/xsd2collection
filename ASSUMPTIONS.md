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

- If the schema has a `targetNamespace`, the root element is emitted as `<ns0:RootElem xmlns:ns0="...">`.
- Imported namespaces get auto-generated prefixes (`ns1`, `ns2`, …) declared on the root element.
- `elementFormDefault` is fully respected per the XSD file in which each element is declared:
  - **`qualified`** — all locally declared elements in that file get the `ns0:` prefix.
  - **`unqualified`** (default) — locally declared elements have no namespace prefix; only global elements and refs get `ns0:`.
- When a schema includes another file with a different `elementFormDefault`, the included file's setting applies to its own elements. For example, including a `qualified` file inside an `unqualified` host correctly qualifies the included file's local elements while leaving the host file's local elements unqualified.
- Global element references (`ref="..."`) are always namespace-qualified with `ns0:`, regardless of `elementFormDefault`.

## 13. Pipeline validation vs. server validation

The pipeline validates the **generated XML file** (`output/…/*.xml`) against the source XSD immediately after generation. The validation server validates whatever **Postman sends as the request body**, which comes from the `.request.yaml` files written to `postman/collections/`.

These two are only guaranteed to agree **after Postman refreshes its Local View** following a pipeline run. Until then, Postman may send stale XML from a previous generation while the server validates against the updated XSD — causing the server to reject XML that the pipeline accepted.

**Practical rule**: if you change an XSD (especially `elementFormDefault`, `targetNamespace`, or element structure) and re-run the pipeline, always trigger a Postman Local View refresh before sending requests.

## 14. Encoding

- Input XSD files: UTF-16 LE/BE (BOM-detected) and UTF-8 are all handled.
- Output XML is always written as **UTF-8**.
