'use strict';

const fs   = require('fs/promises');
const path = require('path');
const { makeBlankRoute } = require('./util');
const { runInspector }   = require('./pythonRunner');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.tox', '.pytest_cache', 'site-packages',
]);

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);


async function scanFastAPI(rootDir) {
  const routes = [];
  await walkDir(rootDir, routes);
  return routes;
}

async function scanSingleFileFastAPI(filePath) {
  if (!filePath.endsWith('.py')) return [];
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return processFile(content, filePath);
  } catch {
    return [];
  }
}


async function walkDir(dir, routes) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkDir(full, routes);
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      try {
        const content = await fs.readFile(full, 'utf8');
        routes.push(...await processFile(content, full));
      } catch {
        // skip
      }
    }
  }
}


async function processFile(content, file) {
  let result;
  try {
    result = await runInspector(content);
  } catch {
    return [];
  }
  if (!result || result.routes.length === 0) return [];

  const routes = [];
  for (const r of result.routes) {
    const method = r.method.toUpperCase();
    if (!VALID_METHODS.has(method)) continue;

    const route       = makeBlankRoute(method, r.path, file, r.line, 'fastapi');
    const handlerInfo = result.handlers[r.handler];

    if (handlerInfo) {
      const schemaFields = result.schemas[handlerInfo.body_schema];
      if (schemaFields) {
        route.params.body = {
          fields: schemaFields.map(f => ({ ...f, confidence: 'high' })),
          source: 'pydantic',
        };
      }
    }

    if (route.params.body.source === 'none') {
      const usage = result.bodyUsage[r.handler];
      if (usage && usage.length > 0) {
        route.params.body = {
          fields: usage.map(f => ({ ...f, confidence: 'medium' })),
          source: 'destructure',
        };
      }
    }

    const qp = result.queryParams?.[r.handler];
    if (qp && qp.length > 0) {
      route.params.query = qp.map(({ name, type }) => ({ name, type }));
    }

    routes.push(route);
  }
  return routes;
}

module.exports = { scanFastAPI, scanSingleFileFastAPI };