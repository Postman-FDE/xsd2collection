#!/usr/bin/env node
/**
 * run_pipeline.js — Main pipeline orchestrator.
 *
 * Steps:
 *   1. Discover every subdirectory under --schemas that contains .xsd files.
 *   2. Run generate_xml.js for each folder to produce sample XML files.
 *   3. Validate each generated XML against its XSD via validation_server/validate.py.
 *   4. Build a Postman Collection v2.1 JSON per folder and write it to --output.
 *   5. Run convert_collections.js to convert JSONs to Postman request YAMLs
 *      and write postman/environments/local.environment.yaml.
 *
 * Usage:
 *   node run_pipeline.js --schemas=<schemas-root> --output=<output-root> [--python=python3] [--fetch-remote]
 *
 * Flags:
 *   --schemas       Root directory containing schema subdirectories (required)
 *   --output        Root directory for generated output files (required)
 *   --python        Python executable used for validation (default: python3)
 *   --fetch-remote  Pass through to generate_xml.js to allow fetching remote schemaLocation URLs
 *
 * Exit codes:
 *   0   All folders processed; collections and YAMLs written successfully.
 *   1   Missing required arguments, schemas directory not found, or fatal error.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ============================================================
// Args
// ============================================================

function getArg(flag) {
  const arg = process.argv.find(a => a.startsWith(flag + '='));
  return arg ? arg.slice(flag.length + 1) : null;
}

const schemasArg = getArg('--schemas');
const outputArg = getArg('--output');

if (!schemasArg || !outputArg) {
  console.error('Usage: node run_pipeline.js --schemas=<schemas-root> --output=<output-root> [--python=python3] [--fetch-remote]');
  console.error('  --schemas   Root directory containing schema subdirectories (required)');
  console.error('  --output    Root directory for output XML files (required)');
  console.error('  --python    Python executable to use for validation (default: python3)');
  console.error('  --fetch-remote  Pass through to generate_xml.js');
  process.exit(1);
}

const SCHEMAS_ROOT = path.resolve(schemasArg);
const OUTPUT_ROOT = path.resolve(outputArg);
const PYTHON = getArg('--python') || 'python3';
const FETCH_REMOTE = process.argv.includes('--fetch-remote');
const GENERATE_SCRIPT = path.join(__dirname, 'generate_xml.js');
const VALIDATE_SCRIPT = path.join(__dirname, 'validation_server', 'validate.py');

if (!fs.existsSync(SCHEMAS_ROOT)) {
  console.error(`Schemas directory not found: ${SCHEMAS_ROOT}`);
  process.exit(1);
}

// ============================================================
// Helpers
// ============================================================

/** Recursively find all directories that contain at least one .xsd file */
function findXsdDirs(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const hasXsd = entries.some(e => e.isFile() && e.name.endsWith('.xsd'));
  if (hasXsd) results.push(dir);
  for (const e of entries) {
    if (e.isDirectory()) {
      results.push(...findXsdDirs(path.join(dir, e.name)));
    }
  }
  return results;
}

/** Run a command synchronously, streaming output to console. Returns exit code. */
function run(cmd, args, label) {
  console.log(`\n[${label}] ${cmd} ${args.join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', encoding: 'utf-8' });
  if (result.error) {
    console.error(`[${label}] spawn error: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** Run validate.py and return { valid: bool, output: string } */
function validate(xsdPath, xmlPath) {
  const result = spawnSync(PYTHON, [VALIDATE_SCRIPT, xsdPath, xmlPath], { encoding: 'utf-8' });
  const output = (result.stdout || '') + (result.stderr || '');
  const valid = (result.status === 0) && output.includes('✅');
  return { valid, output: output.trim() };
}

// ============================================================
// Postman Collection Builder
// ============================================================

function buildPostmanCollection(name, requests) {
  return {
    info: {
      name,
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: requests.map(({ requestName, url, xmlBody }) => ({
      name: requestName,
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/xml' }],
        body: {
          mode: 'raw',
          raw: xmlBody,
          options: { raw: { language: 'xml' } },
        },
        url: {
          raw: url,
          host: ['{{baseurl}}'],
          path: url.replace('{{baseurl}}/', '').split('/'),
        },
      },
      response: [],
    })),
  };
}

// ============================================================
// Main
// ============================================================

const xsdDirs = findXsdDirs(SCHEMAS_ROOT);
if (xsdDirs.length === 0) {
  console.error(`No directories with .xsd files found under: ${SCHEMAS_ROOT}`);
  process.exit(1);
}

console.log(`Found ${xsdDirs.length} XSD folder(s):`);
xsdDirs.forEach(d => console.log(`  ${d}`));

const summary = {
  folders: xsdDirs.length,
  xmlsGenerated: 0,
  xmlsValid: 0,
  xmlsInvalid: 0,
  collectionsWritten: 0,
  errors: [],
};

for (const xsdDir of xsdDirs) {
  // Compute relative path from schemas root (e.g. "integration/inbound")
  const relDir = path.relative(SCHEMAS_ROOT, xsdDir);
  const outputDir = path.join(OUTPUT_ROOT, relDir);
  const collectionName = relDir.replace(/[\\/]/g, '_') || 'collection';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${relDir}`);
  console.log(`  Input:  ${xsdDir}`);
  console.log(`  Output: ${outputDir}`);

  // Step 1: Generate XMLs
  const generateArgs = [
    GENERATE_SCRIPT,
    `--input=${xsdDir}`,
    `--output=${outputDir}`,
  ];
  if (FETCH_REMOTE) generateArgs.push('--fetch-remote');

  const genExit = run('node', generateArgs, 'generate');
  if (genExit !== 0) {
    const msg = `generate_xml.js failed for ${relDir} (exit ${genExit})`;
    console.error(msg);
    summary.errors.push(msg);
    continue;
  }

  // Collect generated XML files
  if (!fs.existsSync(outputDir)) {
    const msg = `Output dir not created for ${relDir}`;
    console.error(msg);
    summary.errors.push(msg);
    continue;
  }

  const xmlFiles = fs.readdirSync(outputDir).filter(f => f.endsWith('.xml'));
  summary.xmlsGenerated += xmlFiles.length;

  // Step 2: Validate each XML against its XSD
  console.log(`\n[validate] Validating ${xmlFiles.length} XML file(s)...`);
  const validationResults = [];

  for (const xmlFile of xmlFiles) {
    const xmlPath = path.join(outputDir, xmlFile);
    const xsdName = xmlFile.replace(/\.xml$/, '.xsd');
    const xsdPath = path.join(xsdDir, xsdName);

    if (!fs.existsSync(xsdPath)) {
      const msg = `XSD not found for ${xmlFile}: ${xsdPath}`;
      console.warn(`  [WARN] ${msg}`);
      summary.errors.push(msg);
      validationResults.push({ xmlFile, valid: false, note: 'XSD missing' });
      summary.xmlsInvalid++;
      continue;
    }

    const { valid, output } = validate(xsdPath, xmlPath);
    const icon = valid ? '✅' : '❌';
    console.log(`  ${icon} ${xmlFile}`);
    if (!valid) {
      console.log(`     ${output}`);
      summary.errors.push(`Validation failed: ${relDir}/${xmlFile}`);
      summary.xmlsInvalid++;
    } else {
      summary.xmlsValid++;
    }
    validationResults.push({ xmlFile, valid });
  }

  // Step 3: Build Postman collection for this folder
  const requests = [];
  for (const xmlFile of xmlFiles) {
    const xmlPath = path.join(outputDir, xmlFile);
    const xmlBody = fs.readFileSync(xmlPath, 'utf-8');

    // URL: {{baseurl}}/<relDir>/<name-without-ext>
    const requestName = xmlFile.replace(/\.xml$/, '');
    const urlPath = relDir ? `${relDir}/${requestName}` : requestName;
    const url = `{{baseurl}}/${urlPath.replace(/\\/g, '/')}`;

    requests.push({ requestName, url, xmlBody });
  }

  const collection = buildPostmanCollection(collectionName, requests);
  const collectionPath = path.join(outputDir, `${collectionName}.postman_collection.json`);
  fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2), 'utf-8');
  console.log(`\n[postman] Collection written: ${collectionPath}`);
  summary.collectionsWritten++;
}

// ============================================================
// Convert collections to Postman YAML format
// ============================================================

if (summary.collectionsWritten > 0) {
  const CONVERT_SCRIPT = path.join(__dirname, 'convert_collections.js');
  console.log(`\n${'='.repeat(60)}`);
  console.log('Converting collections to Postman YAML format...');
  const convertExit = run('node', [CONVERT_SCRIPT], 'convert');
  if (convertExit !== 0) {
    summary.errors.push('convert_collections.js failed');
    console.error('convert_collections.js failed — Postman YAML files not written');
  }
}

// ============================================================
// Summary
// ============================================================

console.log(`\n${'='.repeat(60)}`);
console.log('PIPELINE SUMMARY');
console.log(`  Folders processed : ${summary.folders}`);
console.log(`  XMLs generated    : ${summary.xmlsGenerated}`);
console.log(`  XMLs valid        : ${summary.xmlsValid}`);
console.log(`  XMLs invalid      : ${summary.xmlsInvalid}`);
console.log(`  Collections written: ${summary.collectionsWritten}`);
if (summary.errors.length > 0) {
  console.log(`\nErrors/Warnings (${summary.errors.length}):`);
  summary.errors.forEach(e => console.log(`  - ${e}`));
}
