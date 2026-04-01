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
    lines.push(`order: ${order}`);

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

    // Pre-request validation script
    lines.push('scripts:');
    lines.push('  - type: beforeRequest');
    lines.push('    code: |-');
    lines.push('      const xmlBody = pm.request.body.toString();');
    lines.push('');
    lines.push('      const validationResult = await new Promise((resolve, reject) => {');
    lines.push('        pm.sendRequest({');
    lines.push("          url: pm.variables.replaceIn('{{validationUrl}}') + pm.request.url.getPath(),");
    lines.push('          method: \'POST\',');
    lines.push('          header: {');
    lines.push("            'Content-Type': 'application/xml'");
    lines.push('          },');
    lines.push('          body: {');
    lines.push("            mode: 'raw',");
    lines.push('            raw: xmlBody');
    lines.push('          }');
    lines.push('        }, function (err, response) {');
    lines.push('          if (err) {');
    lines.push('            reject(err);');
    lines.push('            return;');
    lines.push('          }');
    lines.push('          resolve(response.json());');
    lines.push('        });');
    lines.push('      });');
    lines.push('');
    lines.push("      console.log('Validation result:', JSON.stringify(validationResult, null, 2));");
    lines.push('');
    lines.push('      if (!validationResult.valid) {');
    lines.push("        console.error('❌ XSD Validation failed: ' + validationResult.message);");
    lines.push("        throw new Error('XSD Validation failed: ' + validationResult.message);");
    lines.push('      } else {');
    lines.push("        console.log('✅ XSD validation passed, proceeding with request...');");
    lines.push('      }');
    lines.push('    language: text/javascript');

    const yaml = lines.join('\n') + '\n';
    fs.writeFileSync(filePath, yaml, 'utf-8');
    totalRequests++;
    order += 1000;
  }

  totalCollections++;
  console.log(`  ✅ ${collName}: ${items.length} request(s) → ${destDir}`);
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
console.log('  ✅ Environment written → postman/environments/local.environment.yaml');

console.log(`\nDone. ${totalCollections} collection(s), ${totalRequests} request file(s) written.`);
