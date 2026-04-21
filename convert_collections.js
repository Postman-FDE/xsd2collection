#!/usr/bin/env node
/**
 * convert_collections.js — Postman collection JSON → request YAML converter.
 *
 * Reads every .postman_collection.json under output/ and for each collection:
 *   - Creates postman/collections/<collectionName>/ with one .request.yaml per request.
 *   - Creates postman/collections/<collectionName>/.resources/definition.yaml (collection metadata).
 *
 * Each request YAML embeds a beforeRequest script that calls the validation server
 * ({{validationUrl}}) to validate the XML body against its XSD before the request is sent.
 * Saved response examples (v2.1 `item.response[]`) are written as Postman v3
 * `$kind: http-example` files under `.resources/<request>.resources/examples/` and linked via
 * `examples: ./.resources/<request>.resources/examples` (inline `response:` is not loaded by Local View).
 * Test scripts (`listen: test`) are written as `type: afterResponse` under `scripts:`.
 *
 * Also writes postman/environments/local.environment.yaml with:
 *   - baseurl     — base URL for all requests (default: https://api.example.com)
 *   - validationUrl — URL of the Python validation server (default: http://localhost:3456)
 *
 * Usage:
 *   node convert_collections.js
 *   (called automatically by run_pipeline.js after collection JSONs are written)
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_DIR      = path.join(__dirname, 'output');
const COLLECTIONS_DIR = path.join(__dirname, 'postman', 'collections');
const ENVIRONMENTS_DIR = path.join(__dirname, 'postman', 'environments');

// ── helpers ──────────────────────────────────────────────────────

/** Recursively find files matching a predicate */
function walk(dir, predicate, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, results);
    else if (predicate(entry.name)) results.push(full);
  }
  return results;
}

/** Sanitise a request name for use as a filename (no / \ : * ? " < > |) */
function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '-');
}

/** Escape a YAML string value – single-quote if it contains special chars */
function yamlVal(s) {
  if (s === undefined || s === null) return "''";
  s = String(s);
  // Always single-quote if it contains {{ }}, colons, #, or other YAML-special chars
  if (/[{}\[\]:*&#!|>%@`'"\n\r]/.test(s) || s.trim() !== s || s === '') {
    // Escape internal single quotes by doubling them
    return "'" + s.replace(/'/g, "''") + "'";
  }
  return s;
}

/** Map raw body language to http-example body type */
function exampleBodyType(lang) {
  const typeMap = { xml: 'xml', json: 'json', javascript: 'javascript', html: 'html', text: 'text' };
  return typeMap[lang] || 'text';
}

/**
 * Write one Postman v3 http-example file (matches `postman collection migrate` layout).
 * https://schema — v2.1 item.response[] uses originalRequest + code/status/header/body.
 */
function writeHttpExampleFile(filePath, r, order) {
  const lines = [];
  lines.push('$kind: http-example');
  const or = r.originalRequest;
  if (or) {
    lines.push('request:');
    if (or.url && or.url.raw) lines.push(`  url: ${yamlVal(or.url.raw)}`);
    if (or.method) lines.push(`  method: ${or.method}`);
    if (or.header && or.header.length > 0) {
      lines.push('  headers:');
      for (const h of or.header) {
        lines.push(`    ${h.key}: ${yamlVal(h.value)}`);
      }
    }
    if (or.body && or.body.mode === 'raw' && or.body.raw != null) {
      const lang = or.body.options && or.body.options.raw && or.body.options.raw.language
        ? or.body.options.raw.language
        : 'text';
      const bodyType = exampleBodyType(lang);
      lines.push('  body:');
      lines.push(`    type: ${bodyType}`);
      lines.push('    content: |-');
      for (const bl of String(or.body.raw).split('\n')) {
        lines.push('      ' + bl);
      }
    }
  }
  lines.push('response:');
  lines.push(`  statusCode: ${r.code != null ? r.code : 200}`);
  lines.push(`  statusText: ${yamlVal(r.status || 'OK')}`);
  if (r.header && r.header.length > 0) {
    lines.push('  headers:');
    for (const h of r.header) {
      lines.push(`    ${h.key}: ${yamlVal(h.value)}`);
    }
  } else {
    lines.push('  headers: {}');
  }
  const respBody = r.body != null && r.body !== '' ? String(r.body) : '';
  const preview = r._postman_previewlanguage || 'text';
  const respType = respBody ? exampleBodyType(preview) : 'text';
  lines.push('  body:');
  lines.push(`    type: ${respType}`);
  if (respBody.includes('\n')) {
    lines.push('    content: |-');
    for (const bl of respBody.split('\n')) {
      lines.push('      ' + bl);
    }
  } else {
    lines.push(`    content: ${respBody === '' ? '""' : yamlVal(respBody)}`);
  }
  lines.push(`order: ${order}`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');
}

// ── main ─────────────────────────────────────────────────────────

const collectionFiles = walk(OUTPUT_DIR, n => n.endsWith('.postman_collection.json'));

if (collectionFiles.length === 0) {
  console.error('No .postman_collection.json files found under', OUTPUT_DIR);
  process.exit(1);
}

let totalRequests = 0;
let totalCollections = 0;

for (const collFile of collectionFiles) {
  const raw = fs.readFileSync(collFile, 'utf-8');
  const collection = JSON.parse(raw);
  const collName = collection.info && collection.info.name
    ? collection.info.name
    : path.basename(collFile, '.postman_collection.json');

  const destDir = path.join(COLLECTIONS_DIR, collName);
  fs.mkdirSync(destDir, { recursive: true });

  // Write definition.yaml (no collection variables)
  const resourcesDir = path.join(destDir, '.resources');
  fs.mkdirSync(resourcesDir, { recursive: true });

  const defYaml = [
    '$kind: collection',
    `name: ${yamlVal(collName)}`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(resourcesDir, 'definition.yaml'), defYaml, 'utf-8');

  const items = collection.item || [];
  let order = 1000;

  for (const item of items) {
    if (!item.request) continue;          // skip folders / non-request items
    const req = item.request;
    const name = item.name || 'Untitled';
    const safeName = sanitize(name);
    const filePath = path.join(destDir, `${safeName}.request.yaml`);

    const method = (req.method || 'GET').toUpperCase();
    const url    = req.url && req.url.raw ? req.url.raw : (typeof req.url === 'string' ? req.url : '');

    // Build YAML lines
    const lines = [];
    lines.push('$kind: http-request');
    // Only include name field if it differs from filename stem
    if (name !== safeName) {
      lines.push(`name: ${yamlVal(name)}`);
    }
    lines.push(`method: ${method}`);
    lines.push(`url: ${yamlVal(url)}`);

    // Headers
    if (req.header && req.header.length > 0) {
      lines.push('headers:');
      for (const h of req.header) {
        lines.push(`  - key: ${yamlVal(h.key)}`);
        lines.push(`    value: ${yamlVal(h.value)}`);
        if (h.description) lines.push(`    description: ${yamlVal(h.description)}`);
        if (h.disabled) lines.push(`    disabled: true`);
      }
    }

    // Body
    if (req.body) {
      const mode = req.body.mode;
      if (mode === 'raw' && req.body.raw != null) {
        const lang = req.body.options && req.body.options.raw && req.body.options.raw.language
          ? req.body.options.raw.language
          : 'text';
        // Map Postman language to our body type
        const typeMap = { xml: 'xml', json: 'json', javascript: 'javascript', html: 'html', text: 'text' };
        const bodyType = typeMap[lang] || 'text';
        lines.push('body:');
        lines.push(`  type: ${bodyType}`);
        lines.push('  content: |-');
        // Indent each line of the body by 4 spaces
        const bodyLines = req.body.raw.split('\n');
        for (const bl of bodyLines) {
          lines.push('    ' + bl);
        }
      }
    }

    if (item.response && item.response.length > 0) {
      const examplesDir = path.join(destDir, '.resources', `${safeName}.resources`, 'examples');
      fs.mkdirSync(examplesDir, { recursive: true });
      for (const ex of item.response) {
        const exLabel = ex.name || 'Example';
        const exampleFileName = `${sanitize(exLabel)}.example.yaml`;
        writeHttpExampleFile(path.join(examplesDir, exampleFileName), ex, order);
      }
      lines.push(`examples: ./.resources/${safeName}.resources/examples`);
    }

    // Scripts — sourced from the collection JSON's `event` array (prerequest → beforeRequest, test → afterResponse)
    const preReqEvent = (item.event || []).find(e => e.listen === 'prerequest');
    const testEvent = (item.event || []).find(e => e.listen === 'test');

    function scriptExecLines(ev) {
      if (!ev || !ev.script || ev.script.exec == null) return null;
      return Array.isArray(ev.script.exec)
        ? ev.script.exec
        : ev.script.exec.split('\n');
    }

    const preLines = scriptExecLines(preReqEvent);
    const testLines = scriptExecLines(testEvent);
    if (preLines || testLines) {
      lines.push('scripts:');
      if (preLines) {
        lines.push('  - type: beforeRequest');
        lines.push('    code: |-');
        for (const sl of preLines) {
          lines.push('      ' + sl);
        }
        lines.push('    language: text/javascript');
      }
      if (testLines) {
        lines.push('  - type: afterResponse');
        lines.push('    code: |-');
        for (const sl of testLines) {
          lines.push('      ' + sl);
        }
        lines.push('    language: text/javascript');
      }
    }

    lines.push(`order: ${order}`);

    const yaml = lines.join('\n') + '\n';
    fs.writeFileSync(filePath, yaml, 'utf-8');
    totalRequests++;
    order += 1000;
  }

  totalCollections++;
  console.log(`  [OK] ${collName}: ${items.length} request(s) -> ${destDir}`);
}

// Write Postman environment with validationUrl
fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
const envYaml = [
  '$kind: environment',
  'name: Local',
  'values:',
  '  - key: baseurl',
  "    value: 'https://api.example.com'",
  '    enabled: true',
  '  - key: validationUrl',
  "    value: 'http://localhost:3456'",
  '    enabled: true',
].join('\n') + '\n';
fs.writeFileSync(path.join(ENVIRONMENTS_DIR, 'local.environment.yaml'), envYaml, 'utf-8');
console.log('  [OK] Environment written -> postman/environments/local.environment.yaml');

console.log(`\nDone. ${totalCollections} collection(s), ${totalRequests} request file(s) written.`);
