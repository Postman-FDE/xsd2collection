#!/usr/bin/env node
/**
 * convert_collections.js
 *
 * Reads every .postman_collection.json under output/ and writes
 * one .request.yaml per request into postman/collections/<folder_name>/.
 * Also writes a definition.yaml for each collection with the baseurl variable.
 */

const fs   = require('fs');
const path = require('path');

const OUTPUT_DIR      = path.join(__dirname, 'output');
const COLLECTIONS_DIR = path.join(__dirname, 'postman', 'collections');

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

  // Write definition.yaml with baseurl variable
  const resourcesDir = path.join(destDir, '.resources');
  fs.mkdirSync(resourcesDir, { recursive: true });

  const defYaml = [
    '$kind: collection',
    `name: ${yamlVal(collName)}`,
    'variables:',
    '  - key: baseurl',
    "    value: 'https://api.example.com'",
    "    description: 'Base URL for the API'",
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

console.log(`\nDone. ${totalCollections} collection(s), ${totalRequests} request file(s) written.`);
