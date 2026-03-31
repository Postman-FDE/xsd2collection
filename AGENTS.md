# AGENTS.md — XSD → XML → Postman Import

## Goal
Read the `schemas/` folder, run the pipeline to generate XML and a Postman collection, then import the collection into Postman.

---

## Inputs
- `schemas/` containing `*.xsd` files (organized in subdirectories)

---

## Step 1) Run the Pipeline

Execute the pipeline script to generate all XML files and build the Postman collection JSON:

```bash
node run_pipeline.js --schemas=schemas/ --output=output/
```

- Discovers every subdirectory under `schemas/` that contains `.xsd` files.
- Generates one XML per XSD file, validates each, and writes a `.postman_collection.json` per schema folder into `output/`.
- The generated collection file for `schemas/integration/inbound/` will be at:
  ```
  output/integration/inbound/integration_inbound.postman_collection.json
  ```
- Run the script synchronously and check its exit code immediately when it returns — do not use any time-based delay or polling.
- If the exit code is 0, proceed to Step 2.
- If the exit code is non-zero, log the error output and stop.

---

## Step 2) Postman Import (handled automatically by the pipeline)

`run_pipeline.js` calls `convert_collections.js` automatically after writing all collection JSONs. No manual step is needed.

`convert_collections.js` reads each `.postman_collection.json` from `output/` and writes one `.request.yaml` file per request into `postman/collections/<folder_name>/`:

```
postman/collections/integration_inbound/
  MyMessage.request.yaml
  OtherMessage.request.yaml
  ...
postman/collections/integration_outbound/
  ...
```

Postman automatically picks up any folder inside `postman/collections/` on the next Local View refresh. No restart or import action needed.

If `convert_collections.js` fails (non-zero exit), the pipeline logs the error in its summary — check the output and re-run after fixing the issue.

---

## Final Checklist

- [ ] `run_pipeline.js` exited with code 0
- [ ] Collection JSON generated at `output/<rel>/<folder_name>.postman_collection.json`
- [ ] `postman/collections/<folder_name>/` created with one `.request.yaml` per request
- [ ] All collections (not just the first) converted and written
- [ ] Postman Local View reflects the updated collections
