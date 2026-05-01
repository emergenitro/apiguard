'use strict';

const fs   = require('fs');
const path = require('path');
const { scanWorkspace }         = require('../scanner');
const { readConfig, routeKey }  = require('../config');

async function generate(options) {
  const root   = path.resolve(options.root || process.cwd());
  const format = (options.format || 'json').toLowerCase();
  const dryRun = !!options.dryRun;

  if (format !== 'json' && format !== 'yaml') {
    console.error('--format must be "json" or "yaml"');
    process.exit(1);
  }

  const defaultOutput = format === 'yaml' ? 'openapi.yaml' : 'openapi.json';
  const outputPath    = path.resolve(options.output || defaultOutput);

  const config   = readConfig(root);
  const excluded = new Set(config.excluded || []);

  if (!dryRun) console.log(`Scanning ${root}...`);

  let routes;
  try {
    routes = await scanWorkspace(root);
  } catch (err) {
    console.error('Scan failed:', err.message);
    process.exit(1);
  }

  const filtered = routes.filter(r => !excluded.has(routeKey(r.method, r.path)));
  const openapi  = buildOpenAPI(filtered, config);

  const serialized = format === 'yaml'
    ? serializeYaml(openapi)
    : JSON.stringify(openapi, null, 2) + '\n';

  if (dryRun) {
    process.stdout.write(serialized);
    return;
  }

  fs.writeFileSync(outputPath, serialized, 'utf8');
  console.log(`\nWrote ${outputPath}`);
  console.log(`  ${filtered.length} route(s) included`);
  if (routes.length !== filtered.length) {
    console.log(`  ${routes.length - filtered.length} excluded`);
  }
}

// ---------- YAML serializer ----------

function serializeYaml(openapi) {
  try {
    const yaml = require('js-yaml');
    return yaml.dump(openapi, { noRefs: true, lineWidth: 120 });
  } catch {
    console.error('js-yaml not found. Run: npm install js-yaml');
    process.exit(1);
  }
}

// ---------- OpenAPI builder ----------

function buildOpenAPI(routes, config) {
  config = config || {};
  const paths = {};

  for (const route of routes) {
    const oaPath = toOpenApiPath(route.path, route.framework);
    if (!paths[oaPath]) paths[oaPath] = {};

    const method    = route.method.toLowerCase();
    const operation = {
      summary:    route.method + ' ' + route.path,
      parameters: [],
      responses:  { '200': { description: 'Success' } },
    };

    for (const p of route.params.path) {
      operation.parameters.push({ name: p.name, in: 'path', required: true, schema: { type: mapType(p.type) } });
    }

    for (const q of route.params.query) {
      operation.parameters.push({ name: q.name, in: 'query', required: false, schema: { type: mapType(q.type) } });
    }

    if (route.params.body.fields.length > 0) {
      const properties = {};
      const required   = [];
      for (const f of route.params.body.fields) {
        properties[f.name] = { type: mapType(f.type) };
        if (f.required) required.push(f.name);
      }
      const contentType = route.params.body.source === 'formdata'
        ? 'multipart/form-data'
        : 'application/json';
      operation.requestBody = {
        required: true,
        content: { [contentType]: { schema: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) } } },
      };
    }

    // Responses — emit every detected status code, fall back to primary
    const responsesToEmit = (route.responses && route.responses.length > 0)
      ? route.responses
      : route.response.shape.length > 0
        ? [{ ...route.response, status: 200 }]
        : [];

    if (responsesToEmit.length > 0) {
      operation.responses = {};
      for (const r of responsesToEmit) {
        if (!r.shape || r.shape.length === 0) continue;
        const code       = String(r.status ?? 200);
        const fallback   = r.status >= 400 ? 'Error' : 'Success';
        const properties = {};
        for (const f of r.shape) {
          properties[f.name] = { type: mapType(f.type) };
          if (f.example !== undefined) properties[f.name].example = f.example;
        }
        operation.responses[code] = {
          description: r.description ?? fallback,
          content: { 'application/json': { schema: { type: 'object', properties } } },
        };
      }
      if (!operation.responses['200']) {
        operation.responses['200'] = { description: 'Success' };
      }
    }

    if (operation.parameters.length === 0) delete operation.parameters;
    paths[oaPath][method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title:   config.title   || 'API',
      version: config.version || '1.0.0',
      ...(config.description ? { description: config.description } : {}),
    },
    ...(config.servers ? { servers: config.servers } : {}),
    paths,
  };
}

function toOpenApiPath(routePath, framework) {
  let p = routePath;
  if (framework === 'nextjs') {
    p = p.replace(/\[\[\.\.\.([^\]]+)\]\]/g, '{$1}');
    p = p.replace(/\[\.\.\.([^\]]+)\]/g,     '{$1}');
    p = p.replace(/\[([^\]]+)\]/g,           '{$1}');
  } else if (framework === 'express') {
    p = p.replace(/:(\w+)/g, '{$1}');
  } else if (framework === 'flask') {
    p = p.replace(/<(?:\w+:)?(\w+)>/g, '{$1}');
  }
  return p;
}

function mapType(t) {
  if (!t) return 'string';
  if (t.endsWith('[]')) return 'array';
  switch (t) {
    case 'string':  return 'string';
    case 'number':  return 'number';
    case 'integer': return 'integer';
    case 'boolean': return 'boolean';
    case 'null':    return 'null';
    default:        return 'string';
  }
}

module.exports = { generate };