'use strict';

const fs   = require('fs/promises');
const path = require('path');
const { makeBlankRoute }                          = require('./util');
const { inferSchemasFromAst, parseSource, findQueryParams, findFunctionInAst } = require('./schemaInfer');
const { createResolverState, collectImportedSchemas } = require('./importResolver');

const HTTP_METHODS    = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const APP_ROUTE_FILES = new Set(['route.ts', 'route.tsx', 'route.js', 'route.jsx', 'route.mjs']);
const PAGE_FILE_EXT   = /\.(ts|tsx|js|jsx|mjs)$/;
const SKIP_DIRS       = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', '.turbo']);

const APP_DIRS       = ['app', path.join('src', 'app')];
const PAGES_API_DIRS = [path.join('pages', 'api'), path.join('src', 'pages', 'api')];

// ---------- Public API ----------

async function scanNextjs(rootDir) {
  const routes   = [];
  const resolver = createResolverState(rootDir);

  for (const sub of APP_DIRS) {
    const full = path.join(rootDir, sub);
    if (await exists(full)) await walkAppRouter(full, full, routes, resolver);
  }
  for (const sub of PAGES_API_DIRS) {
    const full = path.join(rootDir, sub);
    if (await exists(full)) await walkPagesRouter(full, full, routes);
  }

  return routes;
}

async function scanSingleFileNextjs(filePath, rootDir) {
  const resolver = createResolverState(rootDir);

  for (const sub of APP_DIRS) {
    const appRoot = path.join(rootDir, sub);
    if (
      (filePath.startsWith(appRoot + path.sep) || filePath.startsWith(appRoot + '/')) &&
      APP_ROUTE_FILES.has(path.basename(filePath))
    ) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        return extractAppRouterRoutes(content, filePath, appRoot, resolver);
      } catch {
        return [];
      }
    }
  }

  for (const sub of PAGES_API_DIRS) {
    const apiRoot = path.join(rootDir, sub);
    if (filePath.startsWith(apiRoot + path.sep) || filePath.startsWith(apiRoot + '/')) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        return extractPagesRouterRoutes(content, filePath, apiRoot);
      } catch {
        return [];
      }
    }
  }

  return [];
}

// ---------- App Router ----------

async function walkAppRouter(currentDir, appRoot, routes, resolver) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkAppRouter(full, appRoot, routes, resolver);
    } else if (entry.isFile() && APP_ROUTE_FILES.has(entry.name)) {
      try {
        const content = await fs.readFile(full, 'utf8');
        routes.push(...extractAppRouterRoutes(content, full, appRoot, resolver));
      } catch {
        // skip
      }
    }
  }
}

function extractAppRouterRoutes(content, file, appRoot, resolver) {
  const lines    = content.split('\n');
  const urlPath  = appRouterFilePathToUrl(path.relative(appRoot, path.dirname(file)));
  const out      = [];
  const ast      = parseSource(content);
  const importedSchemas = ast ? collectImportedSchemas(ast, file, resolver) : new Map();

  for (const method of HTTP_METHODS) {
    const patterns = [
      new RegExp(`export\\s+async\\s+function\\s+${method}\\b`),
      new RegExp(`export\\s+function\\s+${method}\\b`),
      new RegExp(`export\\s+(?:const|let|var)\\s+${method}\\b`),
    ];

    for (let i = 0; i < lines.length; i++) {
      if (patterns.some(p => p.test(lines[i]))) {
        const route = makeBlankRoute(method, urlPath, file, i + 1, 'nextjs');
        if (ast) {
          const inferred        = inferSchemasFromAst(ast, method, { importedSchemas });
          route.params.body     = inferred.body;
          route.params.query    = inferred.query ?? [];
          route.response        = inferred.response;
          route.responses       = inferred.responses ?? [];
        }
        out.push(route);
        break;
      }
    }
  }

  return out;
}

function appRouterFilePathToUrl(relDir) {
  if (relDir === '' || relDir === '.') return '/';
  const segments = relDir.split(path.sep).filter(seg => {
    if (seg.startsWith('(') && seg.endsWith(')')) return false; // route groups
    if (seg.startsWith('@'))  return false;                      // parallel routes
    if (seg.startsWith('_'))  return false;                      // private folders
    return true;
  });
  return '/' + segments.join('/');
}

// ---------- Pages Router ----------

async function walkPagesRouter(currentDir, apiRoot, routes) {
  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkPagesRouter(full, apiRoot, routes);
    } else if (entry.isFile() && PAGE_FILE_EXT.test(entry.name)) {
      try {
        const content = await fs.readFile(full, 'utf8');
        routes.push(...extractPagesRouterRoutes(content, full, apiRoot));
      } catch {
        // skip
      }
    }
  }
}

function extractPagesRouterRoutes(content, file, apiRoot) {
  const rel      = path.relative(apiRoot, file);
  const noExt    = rel.replace(PAGE_FILE_EXT, '');
  const segments = noExt.split(path.sep);
  if (segments[segments.length - 1] === 'index') segments.pop();
  const urlPath  = '/api' + (segments.length ? '/' + segments.join('/') : '');

  let handlerLine = 1;
  const lines     = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/export\s+default\b/.test(lines[i])) { handlerLine = i + 1; break; }
  }

  const methods = new Set();
  const eqRe    = /req\.method\s*===?\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/g;
  const caseRe  = /case\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]\s*:/g;
  let m;
  while ((m = eqRe.exec(content))   !== null) methods.add(m[1]);
  while ((m = caseRe.exec(content)) !== null) methods.add(m[1]);

  const finalMethods = methods.size > 0 ? Array.from(methods) : ['GET'];
  return finalMethods.map(method => makeBlankRoute(method, urlPath, file, handlerLine, 'nextjs'));
}

// ---------- Helpers ----------

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

module.exports = { scanNextjs, scanSingleFileNextjs };