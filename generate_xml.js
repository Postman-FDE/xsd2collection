#!/usr/bin/env node
/**
 * XSD → XML Generation Pipeline
 * Follows AGENTS.md steps 1-6
 * Handles UTF-8, UTF-16 LE, and UTF-16 BE encoded XSD files
 * No external dependencies - uses only Node.js built-in modules
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// Configuration
// ============================================================

function getArg(flag) {
  const arg = process.argv.find(a => a.startsWith(flag + '='));
  return arg ? arg.slice(flag.length + 1) : null;
}

function usage() {
  console.error('Usage: node generate_xml.js --input=<xsd-dir> --output=<output-dir> [--fetch-remote]');
  console.error('  --input    Directory containing .xsd files (required)');
  console.error('  --output   Directory to write generated XML files (required)');
  console.error('  --fetch-remote  Allow fetching remote schemaLocation URLs');
  process.exit(1);
}

const inputArg = getArg('--input');
const outputArg = getArg('--output');

if (!inputArg || !outputArg) usage();

const WORKING_DIR = __dirname;
const XSD_SOURCE_DIR = path.resolve(inputArg);
const OUTPUT_DIR = path.resolve(outputArg);
const NOTES_FILE = path.join(WORKING_DIR, 'notes.md');

const FETCH_REMOTE = process.argv.includes('--fetch-remote=true') || process.argv.includes('--fetch-remote');

if (!fs.existsSync(XSD_SOURCE_DIR)) {
  console.error(`Input directory not found: ${XSD_SOURCE_DIR}`);
  process.exit(1);
}

const XSD_FILES = fs.readdirSync(XSD_SOURCE_DIR).filter(f => f.endsWith('.xsd'));

const warnings = [];
const errors = [];

function log(msg) { console.log(msg); }
function warn(msg) { warnings.push(msg); console.warn('[WARN] ' + msg); }
function logError(msg) { errors.push(msg); console.error('[ERROR] ' + msg); }

// ============================================================
// UTF-16 / UTF-8 File Reader
// ============================================================
function readXsdFile(filePath) {
  const buf = fs.readFileSync(filePath);
  // Check BOM
  if (buf.length >= 2) {
    if (buf[0] === 0xFF && buf[1] === 0xFE) {
      // UTF-16 LE BOM
      return buf.slice(2).toString('utf16le');
    }
    if (buf[0] === 0xFE && buf[1] === 0xFF) {
      // UTF-16 BE BOM - swap bytes to convert to LE then decode
      const swapped = Buffer.alloc(buf.length - 2);
      for (let i = 2; i < buf.length - 1; i += 2) {
        swapped[i - 2] = buf[i + 1];
        swapped[i - 1] = buf[i];
      }
      return swapped.toString('utf16le');
    }
  }
  // Default UTF-8
  return buf.toString('utf-8');
}

// ============================================================
// Minimal XML Parser (no external deps)
// ============================================================
// We parse XML into a simple DOM-like tree structure

class XmlNode {
  constructor(type, name, attrs, ns) {
    this.type = type; // 'element', 'text', 'comment', 'pi'
    this.name = name || '';
    this.attrs = attrs || {};
    this.children = [];
    this.text = '';
    this.ns = ns || '';
    this.localName = '';
    if (name && name.includes(':')) {
      const parts = name.split(':');
      this.ns = parts[0];
      this.localName = parts[1];
    } else {
      this.localName = name || '';
    }
  }
  
  getChildren(localName) {
    return this.children.filter(c => c.type === 'element' && c.localName === localName);
  }
  
  getChild(localName) {
    return this.children.find(c => c.type === 'element' && c.localName === localName);
  }
  
  getAllElements() {
    return this.children.filter(c => c.type === 'element');
  }
  
  attr(name) {
    return this.attrs[name];
  }
  
  getTextContent() {
    let text = '';
    for (const child of this.children) {
      if (child.type === 'text') text += child.text;
      else if (child.type === 'element') text += child.getTextContent();
    }
    return text;
  }
}

function parseXml(xmlStr) {
  // Remove XML declaration
  xmlStr = xmlStr.replace(/^\uFEFF/, ''); // Remove BOM if still present
  
  let pos = 0;
  
  function skipWhitespace() {
    while (pos < xmlStr.length && /\s/.test(xmlStr[pos])) pos++;
  }
  
  function parseAttrs() {
    const attrs = {};
    while (pos < xmlStr.length) {
      skipWhitespace();
      if (pos >= xmlStr.length || xmlStr[pos] === '>' || xmlStr[pos] === '/' || xmlStr[pos] === '?') break;
      // Parse attribute name
      let nameStart = pos;
      while (pos < xmlStr.length && xmlStr[pos] !== '=' && xmlStr[pos] !== '>' && xmlStr[pos] !== '/' && !/\s/.test(xmlStr[pos])) pos++;
      const attrName = xmlStr.slice(nameStart, pos).trim();
      if (!attrName) break;
      skipWhitespace();
      if (xmlStr[pos] !== '=') {
        attrs[attrName] = attrName;
        continue;
      }
      pos++; // skip =
      skipWhitespace();
      let quote = xmlStr[pos];
      if (quote !== '"' && quote !== "'") {
        // unquoted value
        let valStart = pos;
        while (pos < xmlStr.length && !/[\s>\/]/.test(xmlStr[pos])) pos++;
        attrs[attrName] = xmlStr.slice(valStart, pos);
        continue;
      }
      pos++; // skip opening quote
      let valStart = pos;
      while (pos < xmlStr.length && xmlStr[pos] !== quote) pos++;
      attrs[attrName] = xmlStr.slice(valStart, pos);
      if (pos < xmlStr.length) pos++; // skip closing quote
    }
    return attrs;
  }
  
  function parseNode() {
    skipWhitespace();
    if (pos >= xmlStr.length) return null;
    
    if (xmlStr[pos] !== '<') {
      // Text node
      let textStart = pos;
      while (pos < xmlStr.length && xmlStr[pos] !== '<') pos++;
      const text = xmlStr.slice(textStart, pos);
      if (text.trim()) {
        const node = new XmlNode('text');
        node.text = text;
        return node;
      }
      return null;
    }
    
    // Check for comment
    if (xmlStr.slice(pos, pos + 4) === '<!--') {
      const endComment = xmlStr.indexOf('-->', pos + 4);
      if (endComment === -1) { pos = xmlStr.length; return null; }
      pos = endComment + 3;
      return null; // skip comments
    }
    
    // Check for CDATA
    if (xmlStr.slice(pos, pos + 9) === '<![CDATA[') {
      const endCdata = xmlStr.indexOf(']]>', pos + 9);
      if (endCdata === -1) { pos = xmlStr.length; return null; }
      const text = xmlStr.slice(pos + 9, endCdata);
      pos = endCdata + 3;
      const node = new XmlNode('text');
      node.text = text;
      return node;
    }
    
    // Check for processing instruction
    if (xmlStr.slice(pos, pos + 2) === '<?') {
      const endPi = xmlStr.indexOf('?>', pos + 2);
      if (endPi === -1) { pos = xmlStr.length; return null; }
      pos = endPi + 2;
      return null; // skip PIs
    }
    
    // Check for closing tag
    if (xmlStr[pos + 1] === '/') {
      return null; // handled by caller
    }
    
    // Opening tag
    pos++; // skip <
    let nameStart = pos;
    while (pos < xmlStr.length && !/[\s\/>]/.test(xmlStr[pos])) pos++;
    const tagName = xmlStr.slice(nameStart, pos);
    
    const attrs = parseAttrs();
    skipWhitespace();
    
    const node = new XmlNode('element', tagName, attrs);
    
    // Self-closing?
    if (xmlStr[pos] === '/') {
      pos++; // skip /
      if (xmlStr[pos] === '>') pos++; // skip >
      return node;
    }
    
    if (xmlStr[pos] === '>') pos++; // skip >
    
    // Parse children
    while (pos < xmlStr.length) {
      skipWhitespace();
      if (pos >= xmlStr.length) break;
      
      // Check for closing tag
      if (xmlStr[pos] === '<' && xmlStr[pos + 1] === '/') {
        // Find end of closing tag
        const endClose = xmlStr.indexOf('>', pos + 2);
        if (endClose !== -1) pos = endClose + 1;
        else pos = xmlStr.length;
        break;
      }
      
      const child = parseNode();
      if (child) node.children.push(child);
      else if (xmlStr[pos] === '<' && xmlStr[pos + 1] === '/') {
        const endClose = xmlStr.indexOf('>', pos + 2);
        if (endClose !== -1) pos = endClose + 1;
        else pos = xmlStr.length;
        break;
      }
    }
    
    return node;
  }
  
  // Parse all top-level nodes
  const root = new XmlNode('element', '#document');
  while (pos < xmlStr.length) {
    skipWhitespace();
    if (pos >= xmlStr.length) break;
    const node = parseNode();
    if (node) root.children.push(node);
    else if (pos < xmlStr.length && xmlStr[pos] !== '<') pos++; // safety advance
  }
  
  return root.children.find(c => c.type === 'element') || root;
}

// ============================================================
// XSD Schema Model
// ============================================================

class SchemaModel {
  constructor() {
    this.globalElements = new Map();    // name -> element definition
    this.complexTypes = new Map();      // name -> complexType definition
    this.simpleTypes = new Map();       // name -> simpleType definition
    this.attributeGroups = new Map();   // name -> attributeGroup definition
    this.namespaces = new Map();        // prefix -> uri
    this.fileElements = new Map();      // filePath -> [element names declared in that file]
    this.fileTargetNs = new Map();      // filePath -> targetNamespace
  }
}

// ============================================================
// Step 1: Resolve xs:include / xs:import
// ============================================================

const loadedFiles = new Map(); // filePath -> parsed XML content
const fileContents = new Map(); // filePath -> raw XML string

function resolveIncludes(filePath, visited = new Set()) {
  const absPath = path.resolve(filePath);
  
  if (loadedFiles.has(absPath)) return;
  if (visited.has(absPath)) {
    warn(`Circular reference detected: ${absPath}`);
    return;
  }
  
  visited.add(absPath);
  
  if (!fs.existsSync(absPath)) {
    logError(`File not found: ${absPath}`);
    return;
  }
  
  log(`Reading: ${path.basename(absPath)}`);
  const xmlStr = readXsdFile(absPath);
  fileContents.set(absPath, xmlStr);
  
  const doc = parseXml(xmlStr);
  loadedFiles.set(absPath, doc);
  
  // Find xs:include and xs:import
  const schemaNode = (doc.localName === 'schema') ? doc : doc.getChild('schema');
  if (!schemaNode) {
    warn(`No schema element found in ${absPath}`);
    return;
  }
  
  const includes = schemaNode.getChildren('include');
  const imports = schemaNode.getChildren('import');
  
  for (const inc of includes) {
    const schemaLoc = inc.attr('schemaLocation');
    if (schemaLoc) {
      if (schemaLoc.startsWith('http://') || schemaLoc.startsWith('https://')) {
        if (!FETCH_REMOTE) { warn(`Remote schema not fetched (use --fetch-remote): ${schemaLoc}`); continue; }
      }
      const resolvedPath = path.resolve(path.dirname(absPath), schemaLoc);
      resolveIncludes(resolvedPath, new Set(visited));
    }
  }

  for (const imp of imports) {
    const schemaLoc = imp.attr('schemaLocation');
    if (schemaLoc) {
      if (schemaLoc.startsWith('http://') || schemaLoc.startsWith('https://')) {
        if (!FETCH_REMOTE) { warn(`Remote schema not fetched (use --fetch-remote): ${schemaLoc}`); continue; }
      }
      const resolvedPath = path.resolve(path.dirname(absPath), schemaLoc);
      resolveIncludes(resolvedPath, new Set(visited));
    }
  }
}

// ============================================================
// Step 2: Build Dependency Graph & Topological Order
// ============================================================

function buildDependencyGraph() {
  const graph = new Map(); // node -> [dependencies]
  const allNodes = new Set();
  
  for (const [filePath, doc] of loadedFiles) {
    allNodes.add(filePath);
    if (!graph.has(filePath)) graph.set(filePath, []);
    
    const schemaNode = (doc.localName === 'schema') ? doc : doc.getChild('schema');
    if (!schemaNode) continue;
    
    const includes = schemaNode.getChildren('include');
    const imports = schemaNode.getChildren('import');
    
    for (const inc of includes) {
      const schemaLoc = inc.attr('schemaLocation');
      if (schemaLoc) {
        const resolvedPath = path.resolve(path.dirname(filePath), schemaLoc);
        if (loadedFiles.has(resolvedPath)) {
          graph.get(filePath).push(resolvedPath);
          allNodes.add(resolvedPath);
        }
      }
    }
    
    for (const imp of imports) {
      const schemaLoc = imp.attr('schemaLocation');
      if (schemaLoc) {
        const resolvedPath = path.resolve(path.dirname(filePath), schemaLoc);
        if (loadedFiles.has(resolvedPath)) {
          graph.get(filePath).push(resolvedPath);
          allNodes.add(resolvedPath);
        }
      }
    }
  }
  
  // DFS post-order topological sort (dependencies before dependents)
  const visited = new Set();
  const order = [];
  
  function dfs(node) {
    if (visited.has(node)) return;
    visited.add(node);
    const deps = graph.get(node) || [];
    for (const dep of deps) {
      dfs(dep);
    }
    order.push(node);
  }
  
  for (const node of allNodes) {
    dfs(node);
  }
  
  return { graph, order };
}

// ============================================================
// Step 3: Build Fully Resolved Type Model
// ============================================================

function getSchemaNode(doc) {
  if (doc.localName === 'schema') return doc;
  return doc.getChild('schema') || doc;
}

function buildTypeModel(order) {
  const model = new SchemaModel();
  
  for (const filePath of order) {
    const doc = loadedFiles.get(filePath);
    if (!doc) continue;
    
    const schemaNode = getSchemaNode(doc);
    const targetNs = schemaNode.attr('targetNamespace') || '';
    model.fileTargetNs.set(filePath, targetNs);
    
    if (!model.fileElements.has(filePath)) {
      model.fileElements.set(filePath, []);
    }
    
    // Collect namespace declarations
    for (const [key, val] of Object.entries(schemaNode.attrs)) {
      if (key.startsWith('xmlns:')) {
        model.namespaces.set(key.slice(6), val);
      } else if (key === 'xmlns') {
        model.namespaces.set('', val);
      }
    }
    
    // Process all children of schema
    for (const child of schemaNode.getAllElements()) {
      if (child.localName === 'element') {
        const name = child.attr('name');
        if (name) {
          model.globalElements.set(name, { node: child, filePath, targetNs });
          model.fileElements.get(filePath).push(name);
        }
      } else if (child.localName === 'complexType') {
        const name = child.attr('name');
        if (name) {
          model.complexTypes.set(name, { node: child, filePath, targetNs });
        }
      } else if (child.localName === 'simpleType') {
        const name = child.attr('name');
        if (name) {
          model.simpleTypes.set(name, { node: child, filePath, targetNs });
        }
      } else if (child.localName === 'attributeGroup') {
        const name = child.attr('name');
        if (name) {
          model.attributeGroups.set(name, { node: child, filePath, targetNs });
        }
      }
    }
  }
  
  return model;
}

// ============================================================
// Step 4 & 5: Root Element Selection & XML Generation
// ============================================================

function getDefaultValue(typeName) {
  if (!typeName) return '';
  // Strip xs: or xsd: prefix
  const local = typeName.replace(/^(xs|xsd):/, '');
  switch (local) {
    case 'string': return '';
    case 'int': case 'integer': case 'long': case 'short': case 'byte':
    case 'unsignedInt': case 'unsignedLong': case 'unsignedShort': case 'unsignedByte':
    case 'positiveInteger': case 'negativeInteger': case 'nonNegativeInteger': case 'nonPositiveInteger':
      return '0';
    case 'decimal': case 'float': case 'double': return '0.0';
    case 'boolean': return 'false';
    case 'dateTime': return '2024-01-01T00:00:00';
    case 'date': return '2024-01-01';
    case 'time': return '00:00:00';
    case 'NMTOKENS': case 'NMTOKEN': case 'token': case 'normalizedString': return '';
    case 'anyURI': return '';
    case 'base64Binary': case 'hexBinary': return '';
    default: return '';
  }
}

function isXsType(typeName) {
  if (!typeName) return false;
  return typeName.startsWith('xs:') || typeName.startsWith('xsd:');
}

// ============================================================
// Sample Values Loader
// ============================================================
// Loads the per-XSD JSON from sample_values/ (mirrors schemas/ structure).
// Returns { fieldMap: Map<name,string>, typeMap: Map<type,string> } or null.
function loadSampleValues(xsdFilePath) {
  const rel = path.relative(WORKING_DIR, xsdFilePath);
  // Strip leading "schemas/" or "schemas\" so the path starts at e.g. "integration/..."
  const withoutSchemas = rel.replace(/^schemas[/\\]/, '');
  const jsonPath = path.join(WORKING_DIR, 'sample_values', withoutSchemas.replace(/\.xsd$/i, '.json'));
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const fieldMap = new Map();
    const typeMap = new Map();
    for (const entry of (raw.FieldLevelDefaultValue || [])) {
      if (entry.fieldName != null && entry.default_value != null) {
        fieldMap.set(String(entry.fieldName), String(entry.default_value));
      }
    }
    for (const entry of (raw.DataTypeLevelDefaultValue || [])) {
      if (entry.data_type != null && entry.default_value != null) {
        typeMap.set(String(entry.data_type), String(entry.default_value));
      }
    }
    return { fieldMap, typeMap };
  } catch (e) {
    warn(`Failed to load sample values from ${jsonPath}: ${e.message}`);
    return null;
  }
}

class XmlGenerator {
  constructor(model) {
    this.model = model;
    this.indent = 0;
    this.lines = [];
    this.importedNsPrefixes = new Map(); // ns -> prefix
    this.nsCounter = 0;
    this.sampleValues = null; // loaded per XSD file in generate()
  }

  // Returns the sample default value for a field name or XSD type, or null if not configured.
  // Priority: FieldLevelDefaultValue (by fieldName) > DataTypeLevelDefaultValue (by type).
  getSampleValue(fieldName, typeName) {
    if (!this.sampleValues) return null;
    const { fieldMap, typeMap } = this.sampleValues;
    if (fieldName && fieldMap.has(fieldName)) return fieldMap.get(fieldName);
    if (typeName) {
      const local = typeName.replace(/^(xs|xsd):/, '');
      if (typeMap.has(local)) return typeMap.get(local);
    }
    return null;
  }
  
  generate(filePath) {
    const doc = loadedFiles.get(filePath);
    if (!doc) {
      logError(`No parsed document for ${filePath}`);
      return null;
    }
    
    const schemaNode = getSchemaNode(doc);
    const targetNs = schemaNode.attr('targetNamespace') || '';
    const elementFormDefault = schemaNode.attr('elementFormDefault') || 'unqualified';
    
    // Find root element: first global xs:element in this file's targetNamespace
    const fileElems = this.model.fileElements.get(filePath) || [];
    
    let rootElemName = null;
    let rootElemDef = null;
    
    for (const elemName of fileElems) {
      const def = this.model.globalElements.get(elemName);
      if (def && def.filePath === filePath) {
        rootElemName = elemName;
        rootElemDef = def;
        break;
      }
    }
    
    if (!rootElemName) {
      // Fallback: use <Root>
      warn(`No global element found in ${path.basename(filePath)}, using <Root> fallback`);
      rootElemName = 'Root';
    }
    
    this.lines = [];
    this.indent = 0;
    this.importedNsPrefixes = new Map();
    this.nsCounter = 0;
    this.sampleValues = loadSampleValues(filePath);
    
    // Collect imported namespaces
    const imports = schemaNode.getChildren('import');
    for (const imp of imports) {
      const ns = imp.attr('namespace');
      if (ns && ns !== targetNs) {
        this.nsCounter++;
        this.importedNsPrefixes.set(ns, `ns${this.nsCounter}`);
      }
    }
    
    this.lines.push('<?xml version="1.0" encoding="UTF-8"?>');
    
    if (rootElemDef) {
      this.generateElement(rootElemDef.node, rootElemName, targetNs, true, elementFormDefault);
    } else {
      // Fallback Root
      this.lines.push(`<Root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`);
    }
    
    return this.lines.join('\n');
  }
  
  getIndent() {
    return '  '.repeat(this.indent);
  }
  
  generateElement(elemNode, elemName, targetNs, isRoot, elementFormDefault) {
    const ind = this.getIndent();
    
    // Build attributes
    let attrs = '';
    
    if (isRoot) {
      if (targetNs) {
        attrs += ` xmlns="${targetNs}"`;
      }
      attrs += ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`;
      for (const [ns, prefix] of this.importedNsPrefixes) {
        attrs += ` xmlns:${prefix}="${ns}"`;
      }
    }
    
    // Get the type info
    const typeName = elemNode.attr('type');
    const ref = elemNode.attr('ref');
    
    if (ref) {
      // Element reference - look up the global element
      const refName = ref.includes(':') ? ref.split(':')[1] : ref;
      const refDef = this.model.globalElements.get(refName);
      if (refDef) {
        this.generateElement(refDef.node, refName, targetNs, false, elementFormDefault);
      } else {
        this.lines.push(`${ind}<${refName}/>`);
        warn(`Cannot resolve element ref: ${ref}`);
      }
      return;
    }
    
    // Collect element attributes from complexType
    const complexTypeChild = elemNode.getChild('complexType');
    const simpleTypeChild = elemNode.getChild('simpleType');
    
    // Get attributes defined on the element's complexType
    let elementAttrs = [];
    let hasChildren = false;
    let childContent = [];
    let textContent = null;
    let textContentType = null;
    
    if (typeName && isXsType(typeName)) {
      // Simple XS type
      const fixedVal = elemNode.attr('fixed');
      const defaultVal = elemNode.attr('default');
      const sv = this.getSampleValue(elemName, typeName);
      const value = fixedVal || defaultVal || sv || getDefaultValue(typeName) || elemName;
      this.lines.push(`${ind}<${elemName}${attrs}>${this.escapeXml(value)}</${elemName}>`);
      return;
    } else if (typeName && !isXsType(typeName)) {
      // Named type reference
      const localTypeName = typeName.includes(':') ? typeName.split(':')[1] : typeName;
      const complexDef = this.model.complexTypes.get(localTypeName);
      const simpleDef = this.model.simpleTypes.get(localTypeName);
      
      if (complexDef) {
        const result = this.processComplexType(complexDef.node, targetNs, elementFormDefault);
        elementAttrs = result.attrs;
        childContent = result.children;
        textContent = result.textContent;
        textContentType = result.textContentType || null;
        hasChildren = childContent.length > 0;
      } else if (simpleDef) {
        const sv = this.getSampleValue(elemName, null);
        const value = sv || this.processSimpleType(simpleDef.node);
        this.lines.push(`${ind}<${elemName}${attrs}>${this.escapeXml(value)}</${elemName}>`);
        return;
      } else {
        // Unknown type
        const fixedVal = elemNode.attr('fixed');
        const defaultVal = elemNode.attr('default');
        const sv = this.getSampleValue(elemName, null);
        const value = fixedVal || defaultVal || sv || '';
        if (value) {
          this.lines.push(`${ind}<${elemName}${attrs}>${this.escapeXml(value)}</${elemName}>`);
        } else {
          this.lines.push(`${ind}<${elemName}${attrs}/>`);
        }
        warn(`Cannot resolve type: ${typeName}`);
        return;
      }
    } else if (complexTypeChild) {
      const result = this.processComplexType(complexTypeChild, targetNs, elementFormDefault);
      elementAttrs = result.attrs;
      childContent = result.children;
      textContent = result.textContent;
      textContentType = result.textContentType || null;
      hasChildren = childContent.length > 0;
    } else if (simpleTypeChild) {
      const sv = this.getSampleValue(elemName, null);
      const value = sv || this.processSimpleType(simpleTypeChild);
      this.lines.push(`${ind}<${elemName}${attrs}>${this.escapeXml(value)}</${elemName}>`);
      return;
    } else {
      // No type info - empty element
      const fixedVal = elemNode.attr('fixed');
      const defaultVal = elemNode.attr('default');
      const sv = this.getSampleValue(elemName, null);
      const value = fixedVal || defaultVal || sv || '';
      if (value) {
        this.lines.push(`${ind}<${elemName}${attrs}>${this.escapeXml(value)}</${elemName}>`);
      } else {
        this.lines.push(`${ind}<${elemName}${attrs}/>`);
      }
      return;
    }
    
    // Build attribute string
    let attrStr = attrs;
    for (const a of elementAttrs) {
      attrStr += ` ${a.name}="${this.escapeXmlAttr(a.value)}"`;
    }
    
    if (textContent !== null) {
      const sv = this.getSampleValue(elemName, textContentType);
      const finalText = sv !== null ? sv : textContent;
      this.lines.push(`${ind}<${elemName}${attrStr}>${this.escapeXml(finalText)}</${elemName}>`);
    } else if (hasChildren) {
      this.lines.push(`${ind}<${elemName}${attrStr}>`);
      this.indent++;
      for (const childFn of childContent) {
        childFn();
      }
      this.indent--;
      this.lines.push(`${ind}</${elemName}>`);
    } else {
      this.lines.push(`${ind}<${elemName}${attrStr}/>`);
    }
  }
  
  processComplexType(ctNode, targetNs, elementFormDefault) {
    const attrs = [];
    const children = [];
    let textContentType = null;
    
    // Process attributes
    for (const attrNode of ctNode.getChildren('attribute')) {
      const attrName = attrNode.attr('name');
      const use = attrNode.attr('use') || 'optional';
      const fixed = attrNode.attr('fixed');
      const defaultVal = attrNode.attr('default');
      const attrType = attrNode.attr('type');
      
      if (use === 'required' || fixed) {
        const value = fixed || defaultVal || getDefaultValue(attrType);
        attrs.push({ name: attrName, value });
      } else if (defaultVal) {
        attrs.push({ name: attrName, value: defaultVal });
      }
    }
    
    // Process sequence
    const sequence = ctNode.getChild('sequence');
    if (sequence) {
      this.processSequence(sequence, children, targetNs, elementFormDefault);
    }
    
    // Process all (treat like sequence)
    const allNode = ctNode.getChild('all');
    if (allNode) {
      this.processSequence(allNode, children, targetNs, elementFormDefault);
    }
    
    // Process choice (first branch only)
    const choice = ctNode.getChild('choice');
    if (choice) {
      this.processChoice(choice, children, targetNs, elementFormDefault);
    }
    
    // Process complexContent
    const complexContent = ctNode.getChild('complexContent');
    if (complexContent) {
      const ext = complexContent.getChild('extension');
      const restr = complexContent.getChild('restriction');
      
      if (ext) {
        const baseName = ext.attr('base');
        if (baseName) {
          const localBase = baseName.includes(':') ? baseName.split(':')[1] : baseName;
          const baseDef = this.model.complexTypes.get(localBase);
          if (baseDef) {
            const baseResult = this.processComplexType(baseDef.node, targetNs, elementFormDefault);
            attrs.push(...baseResult.attrs);
            children.push(...baseResult.children);
          }
        }
        // Process extension's own sequence/choice/attributes
        const extSeq = ext.getChild('sequence');
        if (extSeq) this.processSequence(extSeq, children, targetNs, elementFormDefault);
        const extChoice = ext.getChild('choice');
        if (extChoice) this.processChoice(extChoice, children, targetNs, elementFormDefault);
        for (const attrNode of ext.getChildren('attribute')) {
          const attrName = attrNode.attr('name');
          const use = attrNode.attr('use') || 'optional';
          const fixed = attrNode.attr('fixed');
          const defaultVal = attrNode.attr('default');
          const attrType = attrNode.attr('type');
          if (use === 'required' || fixed) {
            attrs.push({ name: attrName, value: fixed || defaultVal || getDefaultValue(attrType) });
          } else if (defaultVal) {
            attrs.push({ name: attrName, value: defaultVal });
          }
        }
      }
      
      if (restr) {
        // restriction replaces the content model — do NOT inherit base type elements
        const restrSeq = restr.getChild('sequence');
        if (restrSeq) this.processSequence(restrSeq, children, targetNs, elementFormDefault);
        const restrChoice = restr.getChild('choice');
        if (restrChoice) this.processChoice(restrChoice, children, targetNs, elementFormDefault);
        for (const attrNode of restr.getChildren('attribute')) {
          const attrName = attrNode.attr('name');
          const use = attrNode.attr('use') || 'optional';
          const fixed = attrNode.attr('fixed');
          const defaultVal = attrNode.attr('default');
          const attrType = attrNode.attr('type');
          if (use === 'required' || fixed) {
            attrs.push({ name: attrName, value: fixed || defaultVal || getDefaultValue(attrType) });
          } else if (defaultVal) {
            attrs.push({ name: attrName, value: defaultVal });
          }
        }
      }
    }

    // Process simpleContent — element has text content + attributes
    let textContent = null;
    const simpleContent = ctNode.getChild('simpleContent');
    if (simpleContent) {
      const ext = simpleContent.getChild('extension');
      const restr = simpleContent.getChild('restriction');
      const scNode = ext || restr;
      if (scNode) {
        const base = scNode.attr('base');
        const localBase = base && base.includes(':') ? base.split(':')[1] : base;
        const simpleDef = localBase && this.model.simpleTypes.get(localBase);
        if (simpleDef) {
          textContent = this.processSimpleType(simpleDef.node);
        } else {
          textContent = getDefaultValue(base);
        }
        textContentType = base;
        for (const attrNode of scNode.getChildren('attribute')) {
          const attrName = attrNode.attr('name');
          const use = attrNode.attr('use') || 'optional';
          const fixed = attrNode.attr('fixed');
          const defaultVal = attrNode.attr('default');
          const attrType = attrNode.attr('type');
          if (use === 'required' || fixed) {
            attrs.push({ name: attrName, value: fixed || defaultVal || getDefaultValue(attrType) });
          } else if (defaultVal) {
            attrs.push({ name: attrName, value: defaultVal });
          }
        }
      }
    }

    // Resolve attributeGroup references
    for (const agRef of ctNode.getChildren('attributeGroup')) {
      const ref = agRef.attr('ref');
      if (ref) {
        const localRef = ref.includes(':') ? ref.split(':')[1] : ref;
        const agDef = this.model.attributeGroups.get(localRef);
        if (agDef) {
          for (const attrNode of agDef.node.getChildren('attribute')) {
            const attrName = attrNode.attr('name');
            const use = attrNode.attr('use') || 'optional';
            const fixed = attrNode.attr('fixed');
            const defaultVal = attrNode.attr('default');
            const attrType = attrNode.attr('type');
            if (use === 'required' || fixed) {
              attrs.push({ name: attrName, value: fixed || defaultVal || getDefaultValue(attrType) });
            } else if (defaultVal) {
              attrs.push({ name: attrName, value: defaultVal });
            }
          }
        } else {
          warn(`Cannot resolve attributeGroup ref: ${ref}`);
        }
      }
    }

    return { attrs, children, textContent, textContentType };
  }
  
  processSequence(seqNode, children, targetNs, elementFormDefault) {
    for (const child of seqNode.getAllElements()) {
      if (child.localName === 'element') {
        // Always generate one instance of every defined element
        const isRequired = true;
        if (isRequired) {
          const elemName = child.attr('name');
          const ref = child.attr('ref');
          
          if (ref) {
            children.push(() => {
              const refName = ref.includes(':') ? ref.split(':')[1] : ref;
              const refDef = this.model.globalElements.get(refName);
              if (refDef) {
                this.generateElement(refDef.node, refName, targetNs, false, elementFormDefault);
              } else {
                this.lines.push(`${this.getIndent()}<${refName}/>`);
                warn(`Cannot resolve element ref: ${ref}`);
              }
            });
          } else if (elemName) {
            children.push(() => {
              this.generateElement(child, elemName, targetNs, false, elementFormDefault);
            });
          }
        }
      } else if (child.localName === 'sequence') {
        this.processSequence(child, children, targetNs, elementFormDefault);
      } else if (child.localName === 'choice') {
        const choiceMinOccurs = child.attr('minOccurs');
        const choiceMaxOccurs = child.attr('maxOccurs');
        const choiceMin = choiceMinOccurs === undefined || choiceMinOccurs === null ? 1 : parseInt(choiceMinOccurs);
        const choiceMax = choiceMaxOccurs === 'unbounded' ? Infinity : (choiceMaxOccurs !== undefined && choiceMaxOccurs !== null ? parseInt(choiceMaxOccurs) : 1);
        if (choiceMin >= 1 || choiceMax > 1) {
          this.processChoice(child, children, targetNs, elementFormDefault);
        }
      } else if (child.localName === 'group') {
        // Handle group references
        const ref = child.attr('ref');
        if (ref) {
          // Simplified: skip group refs for now
          warn(`Group reference not fully supported: ${ref}`);
        }
      } else if (child.localName === 'any') {
        // xs:any - skip, don't invent content
      }
    }
  }
  
  processChoice(choiceNode, children, targetNs, elementFormDefault) {
    // Generate first branch only
    const elements = choiceNode.getAllElements();
    if (elements.length > 0) {
      const first = elements[0];
      if (first.localName === 'element') {
        const elemName = first.attr('name');
        const ref = first.attr('ref');
        
        if (ref) {
          children.push(() => {
            const refName = ref.includes(':') ? ref.split(':')[1] : ref;
            const refDef = this.model.globalElements.get(refName);
            if (refDef) {
              this.generateElement(refDef.node, refName, targetNs, false, elementFormDefault);
            } else {
              this.lines.push(`${this.getIndent()}<${refName}/>`);
            }
          });
        } else if (elemName) {
          children.push(() => {
            this.generateElement(first, elemName, targetNs, false, elementFormDefault);
          });
        }
      } else if (first.localName === 'sequence') {
        this.processSequence(first, children, targetNs, elementFormDefault);
      }
    }
  }
  
  processSimpleType(stNode) {
    const restriction = stNode.getChild('restriction');
    if (restriction) {
      // Check for enumeration
      const enums = restriction.getChildren('enumeration');
      if (enums.length > 0) {
        return enums[0].attr('value') || '';
      }
      const base = restriction.attr('base');
      return getDefaultValue(base);
    }
    
    const union = stNode.getChild('union');
    if (union) {
      const memberTypes = union.attr('memberTypes');
      if (memberTypes) {
        const firstType = memberTypes.split(/\s+/)[0];
        return getDefaultValue(firstType);
      }
    }
    
    const list = stNode.getChild('list');
    if (list) {
      return '';
    }
    
    return '';
  }
  
  escapeXml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  
  escapeXmlAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

// ============================================================
// Step 6: Write Output Files
// ============================================================

function writeNotes(graph, order, model, outputFiles) {
  let notes = '# XSD → XML Generation Notes\n\n';
  notes += `Generated: ${new Date().toISOString()}\n\n`;
  
  // Step 2: Dependency Graph
  notes += '## Step 2: Dependency Graph & Topological Order\n\n';
  notes += '### Dependency Graph\n\n';
  notes += '| Node | Dependencies |\n';
  notes += '|------|-------------|\n';
  for (const [node, deps] of graph) {
    const nodeName = path.basename(node);
    const depNames = deps.map(d => path.basename(d)).join(', ') || '(none)';
    notes += `| ${nodeName} | ${depNames} |\n`;
  }
  notes += '\n### Topological Order\n\n';
  for (let i = 0; i < order.length; i++) {
    notes += `${i + 1}. ${path.basename(order[i])}\n`;
  }
  notes += '\n';
  
  // Step 3: Type Model
  notes += '## Step 3: Resolved Type Model\n\n';
  
  notes += '### Global Elements\n\n';
  for (const [name, def] of model.globalElements) {
    notes += `- **${name}** (from ${path.basename(def.filePath)}, ns: ${def.targetNs || '(none)'})\n`;
  }
  notes += '\n';
  
  notes += '### Complex Types\n\n';
  if (model.complexTypes.size === 0) {
    notes += '(No named complex types found)\n';
  } else {
    for (const [name, def] of model.complexTypes) {
      notes += `- **${name}** (from ${path.basename(def.filePath)})\n`;
    }
  }
  notes += '\n';
  
  notes += '### Simple Types\n\n';
  if (model.simpleTypes.size === 0) {
    notes += '(No named simple types found)\n';
  } else {
    for (const [name, def] of model.simpleTypes) {
      notes += `- **${name}** (from ${path.basename(def.filePath)})\n`;
    }
  }
  notes += '\n';
  
  // Step 4: Root Elements
  notes += '## Step 4: Root Element Selection\n\n';
  for (const filePath of XSD_FILES.map(f => path.resolve(XSD_SOURCE_DIR, f))) {
    const basename = path.basename(filePath);
    const fileElems = model.fileElements.get(filePath) || [];
    let rootElem = null;
    for (const elemName of fileElems) {
      const def = model.globalElements.get(elemName);
      if (def && def.filePath === filePath) {
        rootElem = elemName;
        break;
      }
    }
    notes += `- **${basename}**: root = ${rootElem || '<Root> (fallback)'}\n`;
  }
  notes += '\n';
  
  // Step 6: Output Files
  notes += '## Step 6: Output Files\n\n';
  for (const [name, filePath] of outputFiles) {
    notes += `- ${filePath}\n`;
  }
  notes += '\n';
  
  // Summary
  notes += '## Summary\n\n';
  notes += `- **Total XSD files processed**: ${XSD_FILES.length}\n`;
  notes += `- **Total XML files written**: ${outputFiles.length}\n`;
  notes += `- **Warnings**: ${warnings.length}\n`;
  if (warnings.length > 0) {
    for (const w of warnings) {
      notes += `  - ${w}\n`;
    }
  }
  notes += `- **Errors**: ${errors.length}\n`;
  if (errors.length > 0) {
    for (const e of errors) {
      notes += `  - ${e}\n`;
    }
  }
  
  if (fs.existsSync(NOTES_FILE)) {
    fs.appendFileSync(NOTES_FILE, '\n---\n\n' + notes, 'utf-8');
  } else {
    fs.writeFileSync(NOTES_FILE, notes, 'utf-8');
  }
  log(`\nNotes written to: ${NOTES_FILE}`);
}

// ============================================================
// Main Pipeline
// ============================================================

function main() {
  log('=== XSD → XML Generation Pipeline ===\n');
  
  // Step 1: Resolve includes/imports
  log('--- Step 1: Resolving xs:include / xs:import ---');
  for (const xsdFile of XSD_FILES) {
    const fullPath = path.resolve(XSD_SOURCE_DIR, xsdFile);
    resolveIncludes(fullPath);
  }
  log(`\nLoaded ${loadedFiles.size} unique XSD files.\n`);
  
  // Step 2: Build dependency graph
  log('--- Step 2: Building Dependency Graph ---');
  const { graph, order } = buildDependencyGraph();
  log(`Topological order (${order.length} files):`);
  for (let i = 0; i < order.length; i++) {
    log(`  ${i + 1}. ${path.basename(order[i])}`);
  }
  log('');
  
  // Step 3: Build type model
  log('--- Step 3: Building Type Model ---');
  const model = buildTypeModel(order);
  log(`Global elements: ${model.globalElements.size}`);
  log(`Complex types: ${model.complexTypes.size}`);
  log(`Simple types: ${model.simpleTypes.size}`);
  log('');
  
  // Create output directory
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  // Steps 4-6: Generate XML and write files
  log('--- Steps 4-6: Generating XML & Writing Output ---');
  const outputFiles = [];
  
  for (const xsdFile of XSD_FILES) {
    const fullPath = path.resolve(XSD_SOURCE_DIR, xsdFile);
    const derivedName = path.basename(xsdFile, '.xsd');
    const outputPath = path.join(OUTPUT_DIR, `${derivedName}.xml`);
    
    log(`\nProcessing: ${xsdFile}`);
    
    const generator = new XmlGenerator(model);
    const xml = generator.generate(fullPath);
    
    if (xml) {
      fs.writeFileSync(outputPath, xml, 'utf-8');
      log(`  → Written: ${outputPath}`);
      outputFiles.push([derivedName, outputPath]);
    } else {
      logError(`Failed to generate XML for ${xsdFile}`);
    }
  }
  
  // Write notes
  log('\n--- Writing notes.md ---');
  writeNotes(graph, order, model, outputFiles);
  
  // Final summary
  log('\n=== SUMMARY ===');
  log(`Total XSD files processed: ${XSD_FILES.length}`);
  log(`Total XML files written: ${outputFiles.length}`);
  log(`Warnings: ${warnings.length}`);
  log(`Errors: ${errors.length}`);
  
  if (warnings.length > 0) {
    log('\nWarnings:');
    for (const w of warnings) log(`  - ${w}`);
  }
  if (errors.length > 0) {
    log('\nErrors:');
    for (const e of errors) log(`  - ${e}`);
  }
}

main();
