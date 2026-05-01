'use strict';

const fs   = require('fs');
const path = require('path');
const { parse }                        = require('@typescript-eslint/typescript-estree');
const { extractZodObjectFieldsFromExpr } = require('./schemaInfer');

const RESOLVE_EXTS     = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const MAX_FOLLOW_DEPTH = 4;

/**
 * Create a fresh resolver state for a project root.
 * @param {string} projectRoot
 */
function createResolverState(projectRoot) {
  return {
    exportCache:  new Map(),
    visiting:     new Set(),
    projectRoot,
    pathAliases:  loadTsconfigAliases(projectRoot),
  };
}

/**
 * Resolve every named import in `ast` to its Zod schema fields (when available).
 * @returns {Map<string, import('../types').SchemaField[]>}
 */
function collectImportedSchemas(ast, fromFile, state) {
  const out = new Map();

  for (const node of ast.body) {
    if (node.type !== 'ImportDeclaration') continue;
    if (typeof node.source.value !== 'string') continue;

    const resolved = resolveImportPath(node.source.value, fromFile, state);
    if (!resolved) continue;

    const exports = getExportedSchemas(resolved, state, 0);
    if (exports.size === 0) continue;

    for (const spec of node.specifiers) {
      if (spec.type !== 'ImportSpecifier') continue;
      const importedName = spec.imported.type === 'Identifier' ? spec.imported.name : null;
      if (!importedName) continue;
      const fields = exports.get(importedName);
      if (fields) out.set(spec.local.name, fields);
    }
  }

  return out;
}

function resolveImportPath(spec, fromFile, state) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    return tryResolveAlias(spec, state) ?? null;
  }
  const target = path.resolve(path.dirname(fromFile), spec);
  return resolveFileWithExts(target);
}

function tryResolveAlias(spec, state) {
  for (const [aliasPrefix, baseDirs] of state.pathAliases) {
    if (!spec.startsWith(aliasPrefix)) continue;
    const remainder = spec.slice(aliasPrefix.length);
    for (const baseDir of baseDirs) {
      const found = resolveFileWithExts(path.resolve(state.projectRoot, baseDir, remainder));
      if (found) return found;
    }
  }
  return null;
}

function resolveFileWithExts(target) {
  if (path.extname(target) && existsSync(target)) return target;
  for (const ext of RESOLVE_EXTS) {
    const c = target + ext;
    if (existsSync(c)) return c;
  }
  for (const ext of RESOLVE_EXTS) {
    const c = path.join(target, 'index' + ext);
    if (existsSync(c)) return c;
  }
  return null;
}

function existsSync(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function getExportedSchemas(file, state, depth) {
  const cached = state.exportCache.get(file);
  if (cached) return cached;
  if (depth > MAX_FOLLOW_DEPTH || state.visiting.has(file)) return new Map();

  state.visiting.add(file);
  const result = new Map();

  try {
    const content = fs.readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parse(content, { jsx: true, loc: true, range: true });
    } catch {
      state.visiting.delete(file);
      state.exportCache.set(file, result);
      return result;
    }

    const localSchemas = new Map();
    for (const node of ast.body) {
      for (const decl of getDeclaratorsFromTopLevel(node)) {
        if (decl.id.type !== 'Identifier' || !decl.init) continue;
        const fields = extractZodObjectFieldsFromExpr(decl.init);
        if (fields) localSchemas.set(decl.id.name, fields);
      }
    }

    for (const node of ast.body) {
      if (node.type === 'ExportNamedDeclaration') {
        if (node.declaration?.type === 'VariableDeclaration') {
          for (const decl of node.declaration.declarations) {
            if (decl.id.type !== 'Identifier') continue;
            const fields = localSchemas.get(decl.id.name);
            if (fields) result.set(decl.id.name, fields);
          }
        }
        for (const spec of node.specifiers) {
          if (spec.type !== 'ExportSpecifier' || spec.local.type !== 'Identifier') continue;
          const fields = localSchemas.get(spec.local.name);
          if (!fields) continue;
          const exportedName = spec.exported.type === 'Identifier' ? spec.exported.name : spec.local.name;
          result.set(exportedName, fields);
        }
        if (node.source && typeof node.source.value === 'string') {
          const reExport = resolveImportPath(node.source.value, file, state);
          if (reExport) {
            const upstream = getExportedSchemas(reExport, state, depth + 1);
            for (const spec of node.specifiers) {
              if (spec.type !== 'ExportSpecifier' || spec.local.type !== 'Identifier') continue;
              const fields = upstream.get(spec.local.name);
              if (!fields) continue;
              const exportedName = spec.exported.type === 'Identifier' ? spec.exported.name : spec.local.name;
              result.set(exportedName, fields);
            }
          }
        }
      } else if (node.type === 'ExportAllDeclaration') {
        if (typeof node.source.value !== 'string') continue;
        const reExport = resolveImportPath(node.source.value, file, state);
        if (!reExport) continue;
        const upstream = getExportedSchemas(reExport, state, depth + 1);
        for (const [name, fields] of upstream) {
          if (!result.has(name)) result.set(name, fields);
        }
      }
    }
  } catch {
    // unreadable - return empty
  } finally {
    state.visiting.delete(file);
  }

  state.exportCache.set(file, result);
  return result;
}

function getDeclaratorsFromTopLevel(node) {
  if (node.type === 'VariableDeclaration') return node.declarations;
  if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
    return node.declaration.declarations;
  }
  return [];
}

function loadTsconfigAliases(projectRoot) {
  const aliases     = new Map();
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return aliases;

  try {
    const raw    = fs.readFileSync(tsconfigPath, 'utf8');
    const parsed = parseJsonWithComments(raw);
    if (!parsed || typeof parsed !== 'object') return aliases;

    const compilerOptions = parsed.compilerOptions;
    if (!compilerOptions) return aliases;

    const baseUrl = typeof compilerOptions.baseUrl === 'string' ? compilerOptions.baseUrl : '.';
    const paths   = compilerOptions.paths;
    if (!paths || typeof paths !== 'object') return aliases;

    for (const [aliasPattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      const aliasPrefix = aliasPattern.replace(/\*$/, '');
      const baseDirs    = targets
        .filter(t => typeof t === 'string')
        .map(t => path.join(baseUrl, t.replace(/\*$/, '')));
      if (aliasPrefix && baseDirs.length > 0) aliases.set(aliasPrefix, baseDirs);
    }
  } catch {
    // ignore
  }

  return aliases;
}

function parseJsonWithComments(raw) {
  const out = [];
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const ch   = raw[i];
    const next = i + 1 < n ? raw[i + 1] : '';

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && raw[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out.push(ch); i++;
      while (i < n) {
        const c = raw[i];
        out.push(c); i++;
        if (c === '\\' && i < n) { out.push(raw[i]); i++; continue; }
        if (c === quote) break;
      }
      continue;
    }
    out.push(ch); i++;
  }

  const stripped = out.join('').replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(stripped); } catch { return null; }
}

module.exports = { createResolverState, collectImportedSchemas };
