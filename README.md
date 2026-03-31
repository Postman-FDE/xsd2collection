# xsd2collection

Turn folders of **XML Schema (XSD)** files into **sample XML**, validate it, and emit **Postman** collections plus **request YAML** for Postman’s local collection format.

The detailed steps and checklist live in **[AGENTS.md](./AGENTS.md)**. Pick **one** path below: Postman Agent mode, or manual run.

## What it does

1. **Discovers** every directory under your schemas root that contains at least one `.xsd` file (including nested paths such as `schemas/sample/`).
2. **Generates** one XML file per XSD using `generate_xml.js` (Node only; no npm dependencies).
3. **Validates** each XML against its XSD with `validate.py` (Python; see [requirements.txt](./requirements.txt)).
4. **Builds** a Postman Collection v2.1 JSON per schema folder under `output/<relative-path>/`.
5. **Converts** those JSON files into `postman/collections/<folder_name>/` as `.request.yaml` (and definitions) via `convert_collections.js`.

## Requirements

- **Node.js** (for `run_pipeline.js`, `generate_xml.js`, `convert_collections.js`)
- **Python 3** with packages from [requirements.txt](./requirements.txt) (currently [xmlschema](https://pypi.org/project/xmlschema/) for `validate.py`):

  ```bash
  python3 -m pip install -r requirements.txt
  ```

  Use a virtual environment if you prefer (`python3 -m venv .venv && source .venv/bin/activate` then the same `pip install`).

  If the interpreter you use for the pipeline is not `python3`, pass `--python=/path/to/python` to `run_pipeline.js` (that executable must have the requirements installed).

## Run with Postman Agent mode

Use this when you want **Postman Agent** to drive the workflow using this repo on disk.

1. **Clone** this repository with Git so you have a stable path (for example `git clone <repo-url>` then `cd xsd2collection`).
2. In **Postman Agent mode**, attach or add **[AGENTS.md](./AGENTS.md)** as the **skill** / instructions file so the agent knows the exact commands, exit-code rules, and **Final Checklist**.
3. **Connect Postman to the clone with Local mode and file access:**
   - Use a Postman workspace or mode where collections are **file-backed** (often **Local** or similar; labels vary by version).
   - When Postman requests **filesystem access**, allow it so it can read your clone (on macOS you may need to grant folder or full disk access in System Settings if prompted).
   - **Link** Postman to `<your-clone>/postman/collections` (for example `/…/xsd2collection/postman/collections` or `C:\…\xsd2collection\postman\collections`).
4. Tell the agent to follow **AGENTS.md**: install Python dependencies from `requirements.txt`, run `node run_pipeline.js --schemas=schemas/ --output=output/`, confirm exit code **0**, then complete the checklist (including refreshing Local view so new `.request.yaml` files appear).

The agent should use the same machine (or environment) where **Node.js**, **Python 3**, and **xmlschema** are available, as in **Requirements**.

## Manual run

Use this when you run the pipeline yourself in a terminal and wire Postman to the generated files.

1. **Install** dependencies once (**Requirements** above): `python3 -m pip install -r requirements.txt` and ensure Node.js is installed.
2. From the **repository root**, run:

   ```bash
   node run_pipeline.js --schemas=schemas/ --output=output/
   ```

3. **Optional flags:**

   ```bash
   node run_pipeline.js --schemas=schemas/ --output=output/ --python=python3
   node run_pipeline.js --schemas=schemas/ --output=output/ --fetch-remote
   ```

   `--fetch-remote` is forwarded to `generate_xml.js` for schemas that reference remote `schemaLocation` URLs.

4. **Exit code:** **0** means generation, validation, collection JSON, and YAML conversion all succeeded; non-zero means stop and read the error output.
5. **Postman (manual):** open Postman (desktop), enable **Local** / file-based collections, grant **file access** if asked, and **open or add** `<your-clone>/postman/collections`. After each pipeline run, **refresh** the Local view. You do not need to import `.postman_collection.json` if you use the YAML under `postman/collections/<folder_name>/`.
6. Walk through the **Final Checklist** in **[AGENTS.md](./AGENTS.md)**.

**Request details:** `{{baseurl}}` is defined in each collection’s `.resources/definition.yaml` (default `https://api.example.com`). Requests use `Content-Type: application/xml` and the generated XML body.

**Optional:** commit `postman/collections/` in Git if your team wants those files versioned.

## Schema layout

- Put **only** XSD files that should each produce one XML + one request in the **same directory**.
- The pipeline does **not** treat `.xsd` files sitting directly under the schemas root as a folder; use a subdirectory (see `schemas/sample/BasicDocument.xsd`).

Example:

```
schemas/
  sample/
    BasicDocument.xsd
  integration/
    inbound/
      MyMessage.xsd
```

Outputs for `schemas/sample/`:

- `output/sample/BasicDocument.xml`
- `output/sample/sample.postman_collection.json`
- `postman/collections/sample/BasicDocument.request.yaml`

Collection and folder names are derived from the path under the schemas root (slashes become underscores in the collection name).

## Scripts (reference)

| Script | Role |
|--------|------|
| `run_pipeline.js` | Orchestrates discovery, generate, validate, Postman JSON, and YAML conversion |
| `generate_xml.js` | `node generate_xml.js --input=<xsd-dir> --output=<out-dir>` |
| `validate.py` | `python3 validate.py <schema.xsd> <instance.xml>` (install [requirements.txt](./requirements.txt) first) |
| `convert_collections.js` | Reads `output/**/*.postman_collection.json`, writes under `postman/collections/` |

`generate_xml.js` also writes `notes.md` in the repo root when it runs (dependency / generation notes).