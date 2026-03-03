#!/usr/bin/env node
// schema-gen — Generate JSON Schema Draft-7 from sample data
// Zero external dependencies. Node 18+.

import { readFileSync, existsSync } from 'fs';
import { createInterface } from 'readline';

// ─── Format Detectors ────────────────────────────────────────────────────────

const FORMATS = [
  { name: 'date-time', re: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/ },
  { name: 'date',      re: /^\d{4}-\d{2}-\d{2}$/ },
  { name: 'email',     re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  { name: 'uri',       re: /^https?:\/\/[^\s]+$/ },
  { name: 'uuid',      re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
];

function detectFormat(val) {
  for (const { name, re } of FORMATS) {
    if (re.test(val)) return name;
  }
  return null;
}

// ─── Schema Inference ────────────────────────────────────────────────────────

function inferSchema(value) {
  if (value === null) return { type: 'null' };

  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array' };
    const itemSchemas = value.map(inferSchema);
    const merged = mergeSchemas(itemSchemas);
    return { type: 'array', items: merged };
  }

  if (typeof value === 'boolean') return { type: 'boolean' };

  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }

  if (typeof value === 'string') {
    const schema = { type: 'string' };
    const fmt = detectFormat(value);
    if (fmt) {
      schema.format = fmt;
    } else {
      schema.minLength = value.length;
      schema.maxLength = value.length;
    }
    return schema;
  }

  if (typeof value === 'object') {
    const props = {};
    const required = Object.keys(value);
    for (const key of required) {
      props[key] = inferSchema(value[key]);
    }
    const schema = { type: 'object', properties: props };
    if (required.length > 0) schema.required = required;
    return schema;
  }

  return {};
}

// ─── Schema Merging ──────────────────────────────────────────────────────────

function mergeTypeArrays(a, b) {
  const setA = new Set(Array.isArray(a) ? a : [a]);
  const setB = new Set(Array.isArray(b) ? b : [b]);
  const union = [...new Set([...setA, ...setB])];
  return union.length === 1 ? union[0] : union;
}

function mergeTwo(a, b) {
  if (!a) return b;
  if (!b) return a;

  const result = {};

  // Merge types
  if (a.type !== undefined && b.type !== undefined) {
    if (a.type === b.type) {
      result.type = a.type;
    } else {
      result.type = mergeTypeArrays(a.type, b.type);
    }
  } else if (a.type !== undefined) {
    result.type = a.type;
  } else if (b.type !== undefined) {
    result.type = b.type;
  }

  // format: keep only if both agree
  if (a.format && b.format && a.format === b.format) result.format = a.format;

  // minLength: take min
  if (a.minLength !== undefined && b.minLength !== undefined) {
    result.minLength = Math.min(a.minLength, b.minLength);
  } else if (a.minLength !== undefined) {
    result.minLength = a.minLength;
  } else if (b.minLength !== undefined) {
    result.minLength = b.minLength;
  }

  // maxLength: take max
  if (a.maxLength !== undefined && b.maxLength !== undefined) {
    result.maxLength = Math.max(a.maxLength, b.maxLength);
  } else if (a.maxLength !== undefined) {
    result.maxLength = a.maxLength;
  } else if (b.maxLength !== undefined) {
    result.maxLength = b.maxLength;
  }

  // required: intersection (only required if in ALL samples)
  if (a.required && b.required) {
    const intersection = a.required.filter(k => b.required.includes(k));
    if (intersection.length > 0) result.required = intersection;
  }

  // properties: union of keys, merge values
  if (a.properties || b.properties) {
    const propsA = a.properties || {};
    const propsB = b.properties || {};
    const allKeys = new Set([...Object.keys(propsA), ...Object.keys(propsB)]);
    result.properties = {};
    for (const key of allKeys) {
      result.properties[key] = mergeTwo(propsA[key], propsB[key]);
    }
  }

  // items: merge array items schemas
  if (a.items || b.items) {
    result.items = mergeTwo(a.items, b.items);
  }

  return result;
}

function mergeSchemas(schemas) {
  return schemas.reduce((acc, s) => mergeTwo(acc, s), null) || {};
}

// ─── Required Field Overrides ─────────────────────────────────────────────────

function applyStrict(schema) {
  if (schema.type === 'object' && schema.properties) {
    schema.required = Object.keys(schema.properties);
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = applyStrict(schema.properties[key]);
    }
  }
  if (schema.items) schema.items = applyStrict(schema.items);
  return schema;
}

function applyLoose(schema) {
  delete schema.required;
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = applyLoose(schema.properties[key]);
    }
  }
  if (schema.items) schema.items = applyLoose(schema.items);
  return schema;
}

// ─── Generate Command ─────────────────────────────────────────────────────────

function generate(data, opts) {
  let schema;

  if (opts.fromArray) {
    if (!Array.isArray(data)) {
      console.error('Error: --from-array expects a JSON array at root');
      process.exit(1);
    }
    const schemas = data.map(inferSchema);
    schema = mergeSchemas(schemas);
  } else if (Array.isArray(data)) {
    // Auto-detect: array of objects → merge as samples
    if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
      const schemas = data.map(inferSchema);
      schema = mergeSchemas(schemas);
    } else {
      schema = inferSchema(data);
    }
  } else {
    schema = inferSchema(data);
  }

  if (opts.strict) schema = applyStrict(schema);
  if (opts.loose) schema = applyLoose(schema);

  const output = {
    '$schema': 'http://json-schema.org/draft-07/schema#',
  };

  if (opts.title) output.title = opts.title;

  Object.assign(output, schema);
  console.log(JSON.stringify(output, null, 2));
}

// ─── Validator ────────────────────────────────────────────────────────────────

function validate(schema, data, path = '#') {
  const errors = [];

  // Resolve $schema at root — ignored for validation
  if (schema['$schema']) {
    const { '$schema': _, ...rest } = schema;
    schema = rest;
  }

  // allOf
  if (schema.allOf) {
    for (const subSchema of schema.allOf) {
      errors.push(...validate(subSchema, data, path));
    }
    return errors;
  }

  // Type check
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actualType = getJsonType(data);
    // integer is a subtype of number in JSON Schema
    const compatible = types.includes(actualType) ||
      (types.includes('integer') && actualType === 'number' && Number.isInteger(data)) ||
      (types.includes('number') && actualType === 'number');
    if (!compatible) {
      errors.push(`${path}: expected type [${types.join(', ')}], got ${actualType}`);
      return errors; // can't continue type-specific checks
    }
  }

  if (data === null) return errors;

  // String checks
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${path}: string length ${data.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push(`${path}: string length ${data.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.format) {
      const fmt = FORMATS.find(f => f.name === schema.format);
      if (fmt && !fmt.re.test(data)) {
        errors.push(`${path}: string does not match format "${schema.format}"`);
      }
    }
    if (schema.pattern) {
      const re = new RegExp(schema.pattern);
      if (!re.test(data)) {
        errors.push(`${path}: string does not match pattern "${schema.pattern}"`);
      }
    }
  }

  // Number checks
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push(`${path}: ${data} > maximum ${schema.maximum}`);
    }
    if (schema.type === 'integer' && !Number.isInteger(data)) {
      errors.push(`${path}: expected integer, got float ${data}`);
    }
  }

  // Object checks
  if (typeof data === 'object' && !Array.isArray(data)) {
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in data)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, subSchema] of Object.entries(schema.properties)) {
        if (key in data) {
          errors.push(...validate(subSchema, data[key], `${path}.${key}`));
        }
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(data)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}: additional property "${key}" not allowed`);
        }
      }
    }
  }

  // Array checks
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${path}: array length ${data.length} < minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push(`${path}: array length ${data.length} > maxItems ${schema.maxItems}`);
    }
    if (schema.items) {
      data.forEach((item, i) => {
        errors.push(...validate(schema.items, item, `${path}[${i}]`));
      });
    }
  }

  return errors;
}

function getJsonType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  if (typeof val === 'number') return 'number'; // integer check done separately in number block
  return typeof val;
}

function validateCommand(schemaFile, dataFile) {
  if (!existsSync(schemaFile)) {
    console.error(`Error: schema file not found: ${schemaFile}`);
    process.exit(1);
  }
  if (!existsSync(dataFile)) {
    console.error(`Error: data file not found: ${dataFile}`);
    process.exit(1);
  }

  let schema, data;
  try {
    schema = JSON.parse(readFileSync(schemaFile, 'utf8'));
  } catch {
    console.error(`Error: invalid JSON in schema file: ${schemaFile}`);
    process.exit(1);
  }
  try {
    data = JSON.parse(readFileSync(dataFile, 'utf8'));
  } catch {
    console.error(`Error: invalid JSON in data file: ${dataFile}`);
    process.exit(1);
  }

  const errors = validate(schema, data);
  if (errors.length === 0) {
    console.log('✅ Valid — data matches schema');
  } else {
    console.log(`❌ Invalid — ${errors.length} error(s):`);
    for (const err of errors) {
      console.log(`  • ${err}`);
    }
    process.exit(1);
  }
}

// ─── Merge Command ────────────────────────────────────────────────────────────

function mergeCommand(file1, file2) {
  for (const f of [file1, file2]) {
    if (!existsSync(f)) {
      console.error(`Error: file not found: ${f}`);
      process.exit(1);
    }
  }

  let s1, s2;
  try { s1 = JSON.parse(readFileSync(file1, 'utf8')); } catch {
    console.error(`Error: invalid JSON in ${file1}`); process.exit(1);
  }
  try { s2 = JSON.parse(readFileSync(file2, 'utf8')); } catch {
    console.error(`Error: invalid JSON in ${file2}`); process.exit(1);
  }

  const merged = {
    '$schema': 'http://json-schema.org/draft-07/schema#',
    allOf: [s1, s2],
  };

  console.log(JSON.stringify(merged, null, 2));
}

// ─── Diff Command ─────────────────────────────────────────────────────────────

function diffSchemas(a, b, path = '#') {
  const diffs = [];

  const keysA = Object.keys(a || {});
  const keysB = Object.keys(b || {});
  const allKeys = new Set([...keysA, ...keysB]);

  for (const key of allKeys) {
    if (key === '$schema') continue;
    const loc = `${path}.${key}`;
    const va = a?.[key];
    const vb = b?.[key];

    if (va === undefined) {
      diffs.push(`+ ${loc}: ${JSON.stringify(vb)}`);
    } else if (vb === undefined) {
      diffs.push(`- ${loc}: ${JSON.stringify(va)}`);
    } else if (key === 'properties' && typeof va === 'object' && typeof vb === 'object') {
      diffs.push(...diffSchemas(va, vb, `${path}.properties`));
    } else if (key === 'items' && typeof va === 'object' && typeof vb === 'object') {
      diffs.push(...diffSchemas(va, vb, `${path}.items`));
    } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
      diffs.push(`~ ${loc}:`);
      diffs.push(`  < ${JSON.stringify(va)}`);
      diffs.push(`  > ${JSON.stringify(vb)}`);
    }
  }

  return diffs;
}

function diffCommand(file1, file2) {
  for (const f of [file1, file2]) {
    if (!existsSync(f)) {
      console.error(`Error: file not found: ${f}`);
      process.exit(1);
    }
  }

  let s1, s2;
  try { s1 = JSON.parse(readFileSync(file1, 'utf8')); } catch {
    console.error(`Error: invalid JSON in ${file1}`); process.exit(1);
  }
  try { s2 = JSON.parse(readFileSync(file2, 'utf8')); } catch {
    console.error(`Error: invalid JSON in ${file2}`); process.exit(1);
  }

  const diffs = diffSchemas(s1, s2);
  if (diffs.length === 0) {
    console.log('Schemas are structurally identical.');
  } else {
    console.log(`${diffs.length} difference(s) found:\n`);
    console.log(`  Legend: (-) only in ${file1}  (+) only in ${file2}  (~) changed\n`);
    for (const d of diffs) {
      console.log(`  ${d}`);
    }
  }
}

// ─── Help ─────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`schema-gen — Generate JSON Schema Draft-7 from sample data

Usage:
  schema-gen [options] [file]            Generate schema from JSON file or stdin
  schema-gen validate <schema> <data>    Validate data against schema
  schema-gen merge <schema1> <schema2>   Merge two schemas (allOf)
  schema-gen diff <schema1> <schema2>    Show structural differences

Options:
  --from-array       Treat root array as multiple samples to merge
  --strict           Mark all detected fields as required
  --loose            No required fields, all optional
  --title <title>    Add title to the generated schema
  --help, -h         Show this help

Examples:
  echo '{"name":"John","email":"j@x.com","age":30}' | schema-gen
  schema-gen users.json --title "User" --strict
  schema-gen users.json --from-array --loose
  schema-gen validate user-schema.json john.json
  schema-gen merge schema1.json schema2.json
  schema-gen diff v1.json v2.json
`);
}

// ─── Input Reading ────────────────────────────────────────────────────────────

function readFile(filePath) {
  if (!existsSync(filePath)) {
    console.error(`Error: file not found: ${filePath}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    console.error(`Error: invalid JSON in file: ${filePath}`);
    process.exit(1);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin });
    const chunks = [];
    rl.on('line', line => chunks.push(line));
    rl.on('close', () => {
      const raw = chunks.join('\n').trim();
      if (!raw) {
        console.error('Error: no input provided. Use a file argument or pipe JSON to stdin.');
        process.exit(1);
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        console.error('Error: invalid JSON on stdin');
        process.exit(1);
      }
    });
    rl.on('error', reject);
  });
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    if (args.length === 0 && process.stdin.isTTY) {
      printHelp();
      process.exit(0);
    }
  }

  // Sub-commands
  if (args[0] === 'validate') {
    if (args.length < 3) {
      console.error('Usage: schema-gen validate <schema-file> <data-file>');
      process.exit(1);
    }
    validateCommand(args[1], args[2]);
    return;
  }

  if (args[0] === 'merge') {
    if (args.length < 3) {
      console.error('Usage: schema-gen merge <schema1> <schema2>');
      process.exit(1);
    }
    mergeCommand(args[1], args[2]);
    return;
  }

  if (args[0] === 'diff') {
    if (args.length < 3) {
      console.error('Usage: schema-gen diff <schema1> <schema2>');
      process.exit(1);
    }
    diffCommand(args[1], args[2]);
    return;
  }

  // Generate command — parse flags
  const opts = {
    fromArray: false,
    strict: false,
    loose: false,
    title: null,
  };

  let inputFile = null;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === '--from-array') {
      opts.fromArray = true;
    } else if (arg === '--strict') {
      opts.strict = true;
    } else if (arg === '--loose') {
      opts.loose = true;
    } else if (arg === '--title') {
      i++;
      if (i >= args.length) {
        console.error('Error: --title requires a value');
        process.exit(1);
      }
      opts.title = args[i];
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      inputFile = arg;
    } else {
      console.error(`Error: unknown option: ${arg}`);
      process.exit(1);
    }
    i++;
  }

  if (opts.strict && opts.loose) {
    console.error('Error: --strict and --loose are mutually exclusive');
    process.exit(1);
  }

  let data;
  if (inputFile) {
    data = readFile(inputFile);
  } else {
    data = await readStdin();
  }

  generate(data, opts);
}

main().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
