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

// ---------- Blueprint prefix resolution ----------

/**
 * Extract Blueprint inline prefixes and register_blueprint calls from one file's content.
 * Returns:
 *   inlinePrefixes: Map<varName, prefix>    e.g. events_bp → "/events"
 *   registrations:  Array<{ parent, child, registeredPrefix }>
 */
function extractBlueprintInfo(content) {
  const inlinePrefixes = new Map();
  const registrations  = [];

  // varname = Blueprint("name", __name__, url_prefix="/prefix")
  const bpRe = /(\w+)\s*=\s*Blueprint\s*\(/g;
  let m;
  while ((m = bpRe.exec(content)) !== null) {
    const varName = m[1];
    const snippet = content.slice(m.index, m.index + 500);
    const pm = /url_prefix\s*=\s*['"]([^'"]+)['"]/.exec(snippet);
    if (pm) inlinePrefixes.set(varName, pm[1]);
  }

  // parent.register_blueprint(child, url_prefix="/prefix")
  const regRe = /(\w+)\.register_blueprint\s*\(/g;
  while ((m = regRe.exec(content)) !== null) {
    const parent  = m[1];
    const snippet = content.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const childM  = /^\s*(\w+)/.exec(snippet);
    if (!childM) continue;
    const child = childM[1];
    const pm    = /url_prefix\s*=\s*['"]([^'"]+)['"]/.exec(snippet);
    registrations.push({ parent, child, registeredPrefix: pm ? pm[1] : '' });
  }

  return { inlinePrefixes, registrations };
}

/**
 * Walk all Python files under rootDir, collect Blueprint definitions and
 * register_blueprint calls, then resolve full prefixes iteratively so
 * nested blueprints (app → api_bp → v1_bp) are handled correctly.
 *
 * @param {string} rootDir
 * @returns {Promise<Map<string, string>>}  varName → full resolved prefix
 */
async function buildBlueprintRegistry(rootDir) {
  const allInline       = new Map();
  const allRegistrations = [];

  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        try {
          const content = await fs.readFile(full, 'utf8');
          const { inlinePrefixes, registrations } = extractBlueprintInfo(content);
          for (const [k, v] of inlinePrefixes) allInline.set(k, v);
          allRegistrations.push(...registrations);
        } catch { /* skip unreadable */ }
      }
    }
  }

  await walk(rootDir);

  // Resolve full prefixes:
  //   - Start with all inline prefixes
  //   - For each register_blueprint call, the child's full prefix = parent's prefix + registeredPrefix
  //   - A registered prefix overrides the inline prefix for the child
  //   - Iterate until stable (handles arbitrarily deep chains)
  const resolved = new Map(allInline);
  let changed = true;
  let iters   = 0;
  while (changed && iters++ < 15) {
    changed = false;
    for (const { parent, child, registeredPrefix } of allRegistrations) {
      if (!registeredPrefix) continue; // no prefix at registration = no contribution
      const parentFull = resolved.get(parent) ?? '';
      const childFull  = parentFull + registeredPrefix;
      if (resolved.get(child) !== childFull) {
        resolved.set(child, childFull);
        changed = true;
      }
    }
  }

  return resolved;
}

// ---------- Public API ----------

async function scanFlask(rootDir) {
  const routes   = [];
  const registry = await buildBlueprintRegistry(rootDir);
  await walkDir(rootDir, routes, registry);
  return routes;
}

async function scanSingleFileFlask(filePath, rootDir) {
  if (!filePath.endsWith('.py')) return [];
  try {
    const content  = await fs.readFile(filePath, 'utf8');
    const registry = rootDir ? await buildBlueprintRegistry(rootDir) : new Map();
    return processFile(content, filePath, registry);
  } catch {
    return [];
  }
}

// ---------- Walk ----------

async function walkDir(dir, routes, registry) {
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
      await walkDir(full, routes, registry);
    } else if (entry.isFile() && entry.name.endsWith('.py')) {
      try {
        const content = await fs.readFile(full, 'utf8');
        routes.push(...await processFile(content, full, registry));
      } catch {
        // skip
      }
    }
  }
}

// ---------- Processing ----------

async function processFile(content, file, registry) {
  const rawRoutes = extractRawRoutes(content, file, registry);
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

// ---------- Route extraction ----------

/**
 * @param {string} content
 * @param {string} file
 * @param {Map<string, string>} globalRegistry  pre-built across all files
 */
function extractRawRoutes(content, file, globalRegistry) {
  // Merge global registry with any Blueprint definitions in THIS file
  // (in-file definitions take precedence for the same variable name)
  const { inlinePrefixes } = extractBlueprintInfo(content);
  const prefixes = new Map([...(globalRegistry ?? new Map()), ...inlinePrefixes]);

  const lines  = content.split('\n');
  const result = [];

  const routeRe      = /@\s*(\w+)\.route\(\s*(['"])([^'"]+)\2\s*(?:,\s*methods\s*=\s*\[([^\]]+)\])?/g;
  const methodShortRe = /@\s*(\w+)\.(get|post|put|patch|delete)\(\s*(['"])([^'"]+)\3/gi;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    routeRe.lastIndex = 0;
    let m;
    while ((m = routeRe.exec(line)) !== null) {
      const bpVar    = m[1];
      const prefix   = prefixes.get(bpVar) ?? '';
      const urlPath  = prefix + m[3];
      const methods  = parseMethodsList(m[4]);
      const handlerName = findHandlerName(lines, i);
      for (const method of methods) {
        result.push({ route: makeBlankRoute(method, urlPath, file, i + 1, 'flask'), handlerName });
      }
    }

    methodShortRe.lastIndex = 0;
    while ((m = methodShortRe.exec(line)) !== null) {
      const bpVar   = m[1];
      const prefix  = prefixes.get(bpVar) ?? '';
      const method  = m[2].toUpperCase();
      if (!VALID_METHODS.has(method)) continue;
      const urlPath = prefix + m[4];
      const handlerName = findHandlerName(lines, i);
      result.push({ route: makeBlankRoute(method, urlPath, file, i + 1, 'flask'), handlerName });
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