# xsd2collection

Turn folders of **XML Schema (XSD)** files into **sample XML**, validate it, and emit **Postman** collections plus request YAML.

## Prerequisites

- **Node.js**
- **Python 3**

## Step 1 — Set up the validation server

The validation server runs on port **3456**. Postman pre-request scripts call it to validate the XML body against the XSD before each request is sent.

Install dependencies (once):

```bash
pip install -r validation_server/requirements.txt
```

Start from the repo root, and keep it running in a separate terminal:

```bash
python validation_server/file_server.py
```

## Step 2 — Set up Postman local workspace

This repo uses Postman's **Native Git** (Local mode), available in Postman desktop v12+ on a team workspace.

1. Open (or create) a **team workspace** in the Postman desktop app — Native Git is not available on personal workspaces.
2. Click **Open Folder** in the left sidebar (or **Connect Git** in the footer bar).
3. In the file picker, select the **root of this cloned repo** and click **Connect**. Postman will use the existing `postman/` folder in the repo.
4. In the footer bar, click the branch name and select **Switch to Local**. You are now in Local mode — Postman reads collections and environments directly from disk.
5. Select `postman/environments/local.environment.yaml` as the active environment.

After this one-time setup, the workspace stays connected to the repo. Switching git branches updates the collections automatically.

## Step 3 — Generate collections

### Agent mode

Tell the agent to generate — Agent mode can read instructions from [AGENTS.md](./AGENTS.md) automatically. It will run the pipeline and confirm the checklist.

### Manual run

```bash
node run_pipeline.js --schemas=schemas/ --output=output/
```

Optional flags:

```bash
node run_pipeline.js --schemas=schemas/ --output=output/ --python=/path/to/python
node run_pipeline.js --schemas=schemas/ --output=output/ --fetch-remote
```

Exit code **0** = success. After the run, refresh the Postman Local view.

## Where things live

- `schemas/` — your XSD source files, organized in subdirectories
- `sample_values/` — optional per-field value overrides for XML generation (see [XML generation](#xml-generation))
- `output/` — generated XML files and Postman collection JSON (intermediate, not used directly)
- `postman/` — Postman Local mode reads from here directly; contains request YAMLs, collection assets, and the local environment file (`baseurl`, `validationUrl`)
- `AGENTS.md` — instructions for the agent (pipeline steps, rules, and final checklist)
- `config.json` — type-level default values used during XML generation

In **Local mode**, Postman watches the folder on disk — after each pipeline run, just refresh the Local view and updated requests appear without any re-import.

## XML generation

Edit `generate_xml.js` to change how sample XML is built.

**Type-level defaults** (e.g. what value to use for `xs:date`, `xs:boolean`) are configured in `config.json` at the repo root under the `typeDefaults` key — edit there instead of touching the generator.

To override field values for a specific XSD without touching either, add a JSON file at `sample_values/<path>/<Name>.json`:

```json
{
  "FieldLevelDefaultValue": [
    { "fieldName": "MyField", "default_value": "example" }
  ],
  "DataTypeLevelDefaultValue": [
    { "data_type": "xs:date", "default_value": "2024-01-01" }
  ]
}
```

See `sample_values/sample/BasicDocument.json` for a working example.

## How it works end to end

1. `run_pipeline.js` discovers every subdirectory under `schemas/` that contains XSD files, then calls `generate_xml.js` per folder to produce a sample XML for each XSD.
2. Each XML is validated against its XSD by `validation_server/validate.py`, and a Postman collection JSON is written to `output/`.
3. `convert_collections.js` converts those JSONs into request YAML files under `postman/collections/`, which Postman reads directly in Local mode.
4. Each generated request includes a **pre-request script** that POSTs the XML body to the local validation server (`http://localhost:3456/<folder>/<RequestName>`) before the actual API call. The server validates the XML against the XSD and returns `{"valid": true}` or an error — blocking the request if validation fails.

So every time you send a request from Postman, the XML is schema-validated locally first, then forwarded to the real API.
