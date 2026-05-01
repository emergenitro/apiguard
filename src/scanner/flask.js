'use strict';

const fs   = require('fs/promises');
const path = require('path');
const { makeBlankRoute }   = require('./util');
const { runInspector }     = require('./pythonRunner');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'env',
  'dist', 'build', '.tox', '.pytest_cache', 'site-packages',
]);

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DEF_RE        = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/;

async function scanFlask(rootDir) {
  const routes = [];
  await walkDir(rootDir, routes);
  return routes;
}

async function scanSingleFileFlask(filePath) {
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
  const rawRoutes = extractRawRoutes(content, file);
  if (rawRoutes.length === 0) return [];

  let inspectorResult = null;
  try {
    inspectorResult = await runInspector(content);
  } catch {
    // fall through without Pydantic schemas
  }

  const routes = [];
  for (const { route, handlerName } of rawRoutes) {
    if (inspectorResult && handlerName) {
      const handlerInfo = inspectorResult.handlers[handlerName];
      if (handlerInfo) {
        const schemaFields = inspectorResult.schemas[handlerInfo.body_schema];
        if (schemaFields) {
          route.params.body = {
            fields: schemaFields.map(f => ({ ...f, confidence: 'high' })),
            source: 'pydantic',
          };
        }
      }
      if (route.params.body.source === 'none') {
        const usage = inspectorResult.bodyUsage[handlerName];
        if (usage && usage.length > 0) {
          route.params.body = {
            fields: usage.map(f => ({ ...f, confidence: 'medium' })),
            source: 'destructure',
          };
        }
      }

      const qp = inspectorResult.queryParams?.[handlerName];
      if (qp && qp.length > 0) {
        route.params.query = qp.map(({ name, type }) => ({ name, type }));
      }
    }
    routes.push(route);
  }
  return routes;
}

function extractRawRoutes(content, file) {
  const lines  = content.split('\n');
  const result = [];

  const routeRe    = /@\s*(\w+)\.route\(\s*(['"])([^'"]+)\2\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?/g;
  const methodShortRe = /@\s*(\w+)\.(get|post|put|patch|delete)\(\s*(['"])([^'"]+)\3/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    routeRe.lastIndex = 0;
    let m;
    while ((m = routeRe.exec(line)) !== null) {
      const urlPath    = m[3];
      const methods    = parseMethodsList(m[4]);
      const handlerName = findHandlerName(lines, i);
      for (const method of methods) {
        result.push({ route: makeBlankRoute(method, urlPath, file, i + 1, 'flask'), handlerName });
      }
    }

    methodShortRe.lastIndex = 0;
    while ((m = methodShortRe.exec(line)) !== null) {
      const method = m[2].toUpperCase();
      if (!VALID_METHODS.has(method)) continue;
      const handlerName = findHandlerName(lines, i);
      result.push({ route: makeBlankRoute(method, m[4], file, i + 1, 'flask'), handlerName });
    }
  }

  return result;
}

function findHandlerName(lines, decoratorLine) {
  for (let j = decoratorLine + 1; j < Math.min(decoratorLine + 8, lines.length); j++) {
    const trimmed = lines[j].trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('@')) continue;
    const m = DEF_RE.exec(lines[j]);
    if (m) return m[1];
    break;
  }
  return null;
}

function parseMethodsList(raw) {
  if (!raw) return ['GET'];
  const out = [];
  for (const item of raw.split(',')) {
    const cleaned = item.trim().replace(/['"]/g, '').toUpperCase();
    if (VALID_METHODS.has(cleaned)) out.push(cleaned);
  }
  return out.length > 0 ? out : ['GET'];
}

module.exports = { scanFlask, scanSingleFileFlask };