'use strict';

const fs   = require('fs/promises');
const path = require('path');
const { makeBlankRoute }                    = require('./util');
const {
  parseSource, buildSchemaMap,
  inferSchemasFromFunction, findFunctionInAst,
} = require('./schemaInfer');
const { createResolverState, collectImportedSchemas } = require('./importResolver');

const SKIP_DIRS = new Set([
  'node_modules', '.next', '.git', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', '.turbo', 'coverage',
]);

const FILE_EXTS         = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const HTTP_METHODS      = new Set(['get', 'post', 'put', 'patch', 'delete']);
const ALL_ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head', 'route']);
const ALL_EMIT_METHODS  = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

// ---------- Public API ----------

async function scanExpress(rootDir) {
  const routes   = [];
  const resolver = createResolverState(rootDir);
  await walkDir(rootDir, rootDir, routes, resolver);
  return routes;
}

async function scanSingleFileExpress(filePath, rootDir) {
  if (!FILE_EXTS.has(path.extname(filePath))) return [];
  try {
    const content  = await fs.readFile(filePath, 'utf8');
    const resolver = createResolverState(rootDir);
    return processFile(content, filePath, resolver);
  } catch {
    return [];
  }
}

// ---------- Walk ----------

async function walkDir(dir, rootDir, routes, resolver) {
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
      await walkDir(full, rootDir, routes, resolver);
    } else if (entry.isFile() && FILE_EXTS.has(path.extname(entry.name))) {
      try {
        const content = await fs.readFile(full, 'utf8');
        routes.push(...processFile(content, full, resolver));
      } catch {
        // skip
      }
    }
  }
}

// ---------- Processing ----------

function processFile(content, file, resolver) {
  const ast = parseSource(content);
  if (!ast) return [];

  const importedSchemas = collectImportedSchemas(ast, file, resolver);
  const schemas         = buildSchemaMap(ast, { importedSchemas });
  const routes          = [];
  extractExpressRoutes(ast, file, schemas, routes);
  return routes;
}

function extractExpressRoutes(ast, file, schemas, routes) {
  for (const node of ast.body) {
    collectFromStatement(node, ast, file, schemas, routes);
  }
}

function collectFromStatement(node, ast, file, schemas, routes) {
  if (node.type === 'ExpressionStatement') {
    tryExtractFromCallChain(node.expression, ast, file, schemas, routes);
  } else if (node.type === 'VariableDeclaration') {
    for (const decl of node.declarations) {
      if (decl.init) tryExtractFromCallChain(decl.init, ast, file, schemas, routes);
    }
  } else if (
    node.type === 'ExportNamedDeclaration' &&
    node.declaration?.type === 'VariableDeclaration'
  ) {
    for (const decl of node.declaration.declarations) {
      if (decl.init) tryExtractFromCallChain(decl.init, ast, file, schemas, routes);
    }
  }
}

function tryExtractFromCallChain(expr, ast, file, schemas, routes) {
  if (expr.type !== 'CallExpression') return;
  if (expr.callee.type !== 'MemberExpression') return;
  if (expr.callee.property.type !== 'Identifier') return;

  const methodName = expr.callee.property.name.toLowerCase();
  if (!ALL_ROUTE_METHODS.has(methodName) || methodName === 'route') return;

  const obj = expr.callee.object;

  if (HTTP_METHODS.has(methodName) || methodName === 'all') {
    const directPath = extractDirectPath(expr);
    if (directPath !== null) {
      emitRoute(methodName, directPath, expr, ast, file, schemas, routes, expr.loc?.start.line ?? 1);
      return;
    }

    const chainPath = extractChainPath(obj);
    if (chainPath !== null) {
      emitRoute(methodName, chainPath, expr, ast, file, schemas, routes, expr.loc?.start.line ?? 1);
      if (obj.type === 'CallExpression') {
        tryExtractFromCallChain(obj, ast, file, schemas, routes);
      }
    }
  }
}

function extractDirectPath(call) {
  const first = call.arguments[0];
  if (!first) return null;
  if (first.type === 'Literal' && typeof first.value === 'string') return first.value;
  if (first.type === 'TemplateLiteral' && first.quasis.length === 1) {
    return first.quasis[0].value.cooked ?? null;
  }
  return null;
}

function extractChainPath(obj) {
  if (obj.type !== 'CallExpression') return null;
  if (obj.callee.type !== 'MemberExpression') return null;
  if (obj.callee.property.type !== 'Identifier') return null;

  const m = obj.callee.property.name.toLowerCase();
  if (m === 'route') {
    const first = obj.arguments[0];
    if (first && first.type === 'Literal' && typeof first.value === 'string') return first.value;
    return null;
  }
  return extractChainPath(obj.callee.object);
}

function emitRoute(methodName, routePath, call, ast, file, schemas, routes, sourceLine) {
  const methods = methodName === 'all'
    ? ALL_EMIT_METHODS
    : [methodName.toUpperCase()];

  for (const method of methods) {
    const route = makeBlankRoute(method, routePath, file, sourceLine, 'express');
    const fn    = resolveHandlerFn(call, ast);
    if (fn) {
      const inferred      = inferSchemasFromFunction(fn, schemas);
      route.params.body   = inferred.body;
      route.params.query  = inferred.query ?? [];
      route.response      = inferred.response;
      route.responses     = inferred.responses ?? [];
    }
    routes.push(route);
  }
}

function resolveHandlerFn(call, ast) {
  const handlerArg = call.arguments[call.arguments.length - 1];
  if (!handlerArg || handlerArg.type === 'SpreadElement') return null;

  if (
    handlerArg.type === 'ArrowFunctionExpression' ||
    handlerArg.type === 'FunctionExpression'
  ) {
    return handlerArg;
  }

  if (handlerArg.type === 'Identifier') {
    return findFunctionInAst(ast, handlerArg.name);
  }

  return null;
}

module.exports = { scanExpress, scanSingleFileExpress };