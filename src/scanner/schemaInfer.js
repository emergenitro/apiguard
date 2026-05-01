'use strict';

const { parse } = require('@typescript-eslint/typescript-estree');

const EMPTY_BODY     = { fields: [], source: 'none' };
const EMPTY_RESPONSE = { shape: [], confidence: 'low', source: 'none' };

const PASS_THROUGH_MODIFIERS = new Set([
  'min', 'max', 'length', 'email', 'url', 'uuid', 'cuid', 'cuid2', 'ulid',
  'regex', 'startsWith', 'endsWith', 'includes', 'trim', 'lowercase', 'uppercase',
  'positive', 'negative', 'nonpositive', 'nonnegative', 'int', 'finite', 'safe',
  'multipleOf', 'gte', 'lte', 'gt', 'lt', 'step',
  'default', 'describe', 'refine', 'transform', 'pipe', 'brand', 'readonly', 'catch',
  'strict', 'strip', 'passthrough', 'partial', 'required', 'deepPartial',
]);

const OPTIONAL_MODIFIERS = new Set(['optional', 'nullable', 'nullish']);
const PARSE_METHODS      = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const RESPONSE_OBJECTS   = new Set(['Response', 'NextResponse', 'res']);

// ---------- Public API ----------

function parseSource(content) {
  try {
    return parse(content, { jsx: true, loc: true, range: true });
  } catch {
    return null;
  }
}

function inferSchemasFromAst(ast, methodName, options = {}) {
  const schemas   = buildSchemaMap(ast, options);
  const handlerFn = findExportedFunction(ast, methodName);
  if (!handlerFn) return { body: EMPTY_BODY, response: EMPTY_RESPONSE, responses: [], query: [] };
  return inferSchemasFromFunction(handlerFn, schemas);
}

function inferSchemasFromFunction(fn, schemas) {
  const body          = findBodySchema(fn, schemas);
  const effectiveBody = body.source === 'none' ? findBodyFromUsage(fn) : body;
  const allResponses  = findAllResponseShapes(fn, schemas);
  return {
    body:      effectiveBody,
    response:  allResponses.length > 0 ? pickPrimaryResponse(allResponses) : EMPTY_RESPONSE,
    responses: allResponses,
    query:     findQueryParams(fn),
  };
}

function buildSchemaMap(ast, options = {}) {
  const localSchemas = collectZodSchemas(ast);
  const merged       = new Map();
  if (options.importedSchemas) {
    for (const [name, fields] of options.importedSchemas) merged.set(name, fields);
  }
  for (const [name, fields] of localSchemas) merged.set(name, fields);
  return merged;
}

function extractZodObjectFieldsFromExpr(expr) {
  return extractZodObjectFields(expr);
}

function findFunctionInAst(ast, name) {
  for (const node of ast.body) {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) return node;
    if (
      node.type === 'ExportNamedDeclaration' &&
      node.declaration?.type === 'FunctionDeclaration' &&
      node.declaration.id?.name === name
    ) return node.declaration;

    const decls = getVariableDeclarators(node);
    for (const decl of decls) {
      if (
        decl.id.type === 'Identifier' &&
        decl.id.name === name &&
        decl.init &&
        (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression')
      ) {
        return decl.init;
      }
    }
  }
  return null;
}

function collectZodSchemas(ast) {
  const out = new Map();
  for (const node of ast.body) {
    const decls = getDeclaratorsFromTopLevel(node);
    for (const decl of decls) {
      if (decl.id.type !== 'Identifier' || !decl.init) continue;
      const fields = extractZodObjectFields(decl.init);
      if (fields) out.set(decl.id.name, fields);
    }
  }
  return out;
}

function findBodyFromUsage(fn) {
  // FormData takes priority — check it first
  const formDataFields = findFormDataFields(fn);
  if (formDataFields.length > 0) {
    return { fields: formDataFields, source: 'formdata' };
  }
  const fields        = [];
  const seen          = new Set();
  const reqParamNames = new Set(['req', 'request']);

  if (fn.params.length > 0) {
    const first = fn.params[0];
    if (first.type === 'Identifier') reqParamNames.add(first.name);
    else if (first.type === 'AssignmentPattern' && first.left.type === 'Identifier') {
      reqParamNames.add(first.left.name);
    }
  }

  const bodyVars = new Set();
  walk(fn.body, node => {
    if (node.type !== 'VariableDeclaration') return;
    for (const decl of node.declarations) {
      if (!decl.init || decl.id.type !== 'Identifier') continue;
      if (isBodyExpr(decl.init, reqParamNames)) bodyVars.add(decl.id.name);
    }
  });

  walk(fn.body, node => {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (!decl.init || decl.id.type !== 'ObjectPattern') continue;
        const fromBody = isBodyExpr(decl.init, reqParamNames);
        const fromVar  = decl.init.type === 'Identifier' && bodyVars.has(decl.init.name);
        if (!fromBody && !fromVar) continue;
        for (const prop of decl.id.properties) {
          if (prop.type !== 'Property') continue;
          const keyName = propertyKeyName(prop.key);
          if (!keyName || seen.has(keyName)) continue;
          seen.add(keyName);
          fields.push({
            name:       keyName,
            type:       prop.value.type === 'ObjectPattern' ? 'object' : 'unknown',
            required:   true,
            confidence: 'medium',
          });
        }
      }
      return;
    }

    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
      if (isBodyMember(node.object, reqParamNames, bodyVars)) {
        const name = node.property.name;
        if (!seen.has(name)) {
          seen.add(name);
          fields.push({ name, type: 'unknown', required: true, confidence: 'medium' });
        }
      }
      return;
    }

    if (node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal') {
      if (isBodyMember(node.object, reqParamNames, bodyVars)) {
        const name = String(node.property.value);
        if (!seen.has(name)) {
          seen.add(name);
          fields.push({ name, type: 'unknown', required: true, confidence: 'medium' });
        }
      }
    }
  });

  if (fields.length === 0) return EMPTY_BODY;
  return { fields, source: 'destructure' };
}

// ---------- Zod schema collection ----------

function getDeclaratorsFromTopLevel(node) {
  if (node.type === 'VariableDeclaration') return node.declarations;
  if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
    return node.declaration.declarations;
  }
  return [];
}

function getVariableDeclarators(node) {
  if (node.type === 'VariableDeclaration') return node.declarations;
  if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') {
    return node.declaration.declarations;
  }
  return [];
}

function extractZodObjectFields(expr) {
  let current = expr;
  while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
    const callee = current.callee;
    if (callee.property.type !== 'Identifier') return null;
    const method = callee.property.name;

    if (callee.object.type === 'Identifier' && callee.object.name === 'z') {
      if (method !== 'object') return null;
      const arg = current.arguments[0];
      if (!arg || arg.type !== 'ObjectExpression') return null;
      return objectExpressionToZodFields(arg);
    }

    if (callee.object.type === 'CallExpression' || callee.object.type === 'MemberExpression') {
      current = callee.object;
      continue;
    }
    return null;
  }
  return null;
}

function objectExpressionToZodFields(obj) {
  const fields = [];
  for (const prop of obj.properties) {
    if (prop.type !== 'Property') continue;
    const name = propertyKeyName(prop.key);
    if (!name) continue;
    if (prop.value.type === 'CallExpression' || prop.value.type === 'MemberExpression') {
      const { type, required } = analyzeZodExpression(prop.value);
      fields.push({ name, type, required, confidence: 'high' });
    } else {
      fields.push({ name, type: 'unknown', required: true, confidence: 'medium' });
    }
  }
  return fields;
}

function analyzeZodExpression(expr) {
  let required = true;
  let current  = expr;

  while (current.type === 'CallExpression' && current.callee.type === 'MemberExpression') {
    const callee = current.callee;
    if (callee.property.type !== 'Identifier') return { type: 'unknown', required };
    const method = callee.property.name;

    if (callee.object.type === 'Identifier' && callee.object.name === 'z') {
      return { type: zodBaseToType(method, current.arguments), required };
    }

    if (OPTIONAL_MODIFIERS.has(method)) {
      required = false;
    } else if (!PASS_THROUGH_MODIFIERS.has(method)) {
      return { type: 'unknown', required };
    }

    if (callee.object.type !== 'CallExpression' && callee.object.type !== 'MemberExpression') {
      return { type: 'unknown', required };
    }
    current = callee.object;
  }

  return { type: 'unknown', required };
}

function zodBaseToType(method, args) {
  switch (method) {
    case 'string':    return 'string';
    case 'number':    return 'number';
    case 'bigint':    return 'bigint';
    case 'boolean':   return 'boolean';
    case 'date':      return 'Date';
    case 'any':       return 'any';
    case 'unknown':   return 'unknown';
    case 'null':      return 'null';
    case 'undefined': return 'undefined';
    case 'void':      return 'void';
    case 'never':     return 'never';
    case 'object':    return 'object';
    case 'record':    return 'Record<string, unknown>';
    case 'literal': {
      const arg = args[0];
      if (arg && arg.type === 'Literal') return JSON.stringify(arg.value);
      return 'literal';
    }
    case 'enum':
    case 'nativeEnum': {
      const arg = args[0];
      if (arg && arg.type === 'ArrayExpression') {
        const values = arg.elements
          .filter(e => e && e.type === 'Literal')
          .map(e => JSON.stringify(e.value));
        if (values.length > 0) return values.join(' | ');
      }
      return 'enum';
    }
    case 'array': {
      const inner = args[0];
      if (inner && inner.type !== 'SpreadElement') {
        return `${analyzeZodExpression(inner).type}[]`;
      }
      return 'unknown[]';
    }
    case 'union': {
      const arg = args[0];
      if (arg && arg.type === 'ArrayExpression') {
        const types = arg.elements
          .filter(e => e && e.type !== 'SpreadElement')
          .map(e => analyzeZodExpression(e).type);
        if (types.length > 0) return types.join(' | ');
      }
      return 'unknown';
    }
    case 'tuple': {
      const arg = args[0];
      if (arg && arg.type === 'ArrayExpression') {
        const types = arg.elements
          .filter(e => e && e.type !== 'SpreadElement')
          .map(e => analyzeZodExpression(e).type);
        return `[${types.join(', ')}]`;
      }
      return 'tuple';
    }
    default: return method;
  }
}

// ---------- Handler lookup ----------

function findExportedFunction(ast, name) {
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) continue;

    if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id?.name === name) {
      return node.declaration;
    }
    if (node.declaration.type === 'VariableDeclaration') {
      for (const decl of node.declaration.declarations) {
        if (decl.id.type !== 'Identifier' || decl.id.name !== name || !decl.init) continue;
        if (
          decl.init.type === 'ArrowFunctionExpression' ||
          decl.init.type === 'FunctionExpression'
        ) return decl.init;
      }
    }
  }
  return null;
}

// ---------- Body schema discovery ----------

function findBodySchema(fn, schemas) {
  let result = EMPTY_BODY;

  walk(fn.body, node => {
    if (result.source !== 'none') return;
    if (node.type !== 'CallExpression') return;
    if (node.callee.type !== 'MemberExpression') return;
    if (node.callee.property.type !== 'Identifier') return;
    if (!PARSE_METHODS.has(node.callee.property.name)) return;
    if (!looksLikeBody(node.arguments[0])) return;

    if (node.callee.object.type === 'Identifier') {
      const fields = schemas.get(node.callee.object.name);
      if (fields) { result = { fields, source: 'zod' }; return; }
    }

    const inlineFields = extractZodObjectFields(node.callee.object);
    if (inlineFields) result = { fields: inlineFields, source: 'zod' };
  });

  return result;
}

function looksLikeBody(arg) {
  if (!arg) return false;
  if (
    arg.type === 'MemberExpression' &&
    arg.property.type === 'Identifier' &&
    arg.property.name === 'body'
  ) return true;
  if (arg.type === 'AwaitExpression' && arg.argument.type === 'CallExpression') {
    const c = arg.argument.callee;
    if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && c.property.name === 'json') {
      return true;
    }
  }
  if (arg.type === 'Identifier' && ['body', 'data', 'json', 'payload', 'input', 'requestBody'].includes(arg.name)) {
    return true;
  }
  return false;
}

// ---------- Response shape ----------

/**
 * Collect every Response.json() / NextResponse.json() / res.json() call in the handler,
 * extract the shape and status code for each one.
 * @returns {Array<{ shape, confidence, source, status: number }>}
 */
function findAllResponseShapes(fn, schemas) {
  const locals = new Map();
  walk(fn.body, node => {
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (decl.id.type === 'Identifier' && decl.init && !locals.has(decl.id.name)) {
          locals.set(decl.id.name, decl.init);
        }
      }
    }
  });

  const results = [];
  walk(fn.body, node => {
    if (node.type !== 'CallExpression') return;
    if (node.callee.type !== 'MemberExpression') return;
    if (node.callee.property.type !== 'Identifier' || node.callee.property.name !== 'json') return;
    if (node.callee.object.type !== 'Identifier') return;
    if (!RESPONSE_OBJECTS.has(node.callee.object.name)) return;

    const arg = node.arguments[0];
    if (!arg || arg.type === 'SpreadElement') return;
    const resolved = resolveResponseArg(arg, locals, schemas, new Set());
    if (!resolved || resolved.shape.length === 0) return;

    // Extract status from second argument: NextResponse.json({...}, { status: 404 })
    let status = 200;
    const optsArg = node.arguments[1];
    if (optsArg && optsArg.type === 'ObjectExpression') {
      for (const prop of optsArg.properties) {
        if (
          prop.type === 'Property' &&
          prop.key.type === 'Identifier' &&
          prop.key.name === 'status' &&
          prop.value.type === 'Literal' &&
          typeof prop.value.value === 'number'
        ) {
          status = prop.value.value;
        }
      }
    }

    // Also handle: new Response(JSON.stringify({...}), { status: 404 })
    // (already caught via RESPONSE_OBJECTS check above)

    // Deduplicate by status — keep first shape found per status code
    if (!results.some(r => r.status === status)) {
      results.push({ ...resolved, status, description: extractResponseDescription(resolved.shape) });
    }
  });

  // Pattern 2: new Response(JSON.stringify({...}), { status: N, headers: {...} })
  walk(fn.body, node => {
    if (node.type !== 'NewExpression') return;
    if (node.callee.type !== 'Identifier' || node.callee.name !== 'Response') return;

    const bodyArg = node.arguments[0];
    if (!bodyArg || bodyArg.type === 'SpreadElement') return;

    // Unwrap JSON.stringify(shapeArg)
    let shapeArg = null;
    if (
      bodyArg.type === 'CallExpression' &&
      bodyArg.callee.type === 'MemberExpression' &&
      bodyArg.callee.object.type === 'Identifier' &&
      bodyArg.callee.object.name === 'JSON' &&
      bodyArg.callee.property.type === 'Identifier' &&
      bodyArg.callee.property.name === 'stringify' &&
      bodyArg.arguments[0] &&
      bodyArg.arguments[0].type !== 'SpreadElement'
    ) {
      shapeArg = bodyArg.arguments[0];
    }
    if (!shapeArg) return;

    const resolved = resolveResponseArg(shapeArg, locals, schemas, new Set());
    if (!resolved || resolved.shape.length === 0) return;

    let status = 200;
    const optsArg = node.arguments[1];
    if (optsArg && optsArg.type === 'ObjectExpression') {
      for (const prop of optsArg.properties) {
        if (
          prop.type === 'Property' &&
          prop.key.type === 'Identifier' &&
          prop.key.name === 'status' &&
          prop.value.type === 'Literal' &&
          typeof prop.value.value === 'number'
        ) {
          status = prop.value.value;
        }
      }
    }

    if (!results.some(r => r.status === status)) {
      results.push({ ...resolved, status, description: extractResponseDescription(resolved.shape) });
    }
  });

  return results;
}

/**
 * Pull a human-readable description out of a response shape when the value is a
 * pre-determined string literal, e.g. { error: 'Unauthorized' } → 'Unauthorized'.
 * Prefers 'message' over 'error' for success responses.
 * @param {Array<{ name: string, example?: string }>} shape
 * @returns {string | null}
 */
function extractResponseDescription(shape) {
  const priority = ['message', 'error', 'detail', 'msg', 'reason', 'description'];
  for (const key of priority) {
    const field = shape.find(f => f.name === key && f.example);
    if (field) return field.example;
  }
  // Fall back to the first field that has a literal string value
  const any = shape.find(f => f.example);
  return any ? any.example : null;
}

/** Pick the most useful single response to surface as the primary. Prefers 200. */
function pickPrimaryResponse(all) {
  const ok = all.find(r => r.status === 200);
  if (ok) return ok;
  // Fall back to the response with the most fields
  return all.reduce((best, r) =>
    (r.shape?.length ?? 0) > (best.shape?.length ?? 0) ? r : best
  , all[0]);
}

// Keep old name as alias so any direct callers don't break
function findResponseShape(fn, schemas) {
  const all = findAllResponseShapes(fn, schemas);
  return all.length > 0 ? pickPrimaryResponse(all) : EMPTY_RESPONSE;
}

function resolveResponseArg(arg, locals, schemas, visited) {
  if (arg.type === 'ObjectExpression') {
    const fields = objectExpressionToShapeFields(arg);
    if (fields.length === 0) return null;
    return { shape: fields, confidence: 'low', source: 'literal' };
  }
  if (arg.type === 'CallExpression') return tryResolveParseCall(arg, schemas);
  if (arg.type === 'AwaitExpression' && arg.argument.type === 'CallExpression') {
    return tryResolveParseCall(arg.argument, schemas);
  }
  if (arg.type === 'Identifier') {
    if (visited.has(arg.name)) return null;
    visited.add(arg.name);
    const init = locals.get(arg.name);
    if (init) return resolveResponseArg(init, locals, schemas, visited);
    const fields = schemas.get(arg.name);
    if (fields) return { shape: fields, confidence: 'high', source: 'literal' };
  }
  return null;
}

function tryResolveParseCall(expr, schemas) {
  if (expr.callee.type !== 'MemberExpression') return null;
  if (expr.callee.property.type !== 'Identifier') return null;
  if (!PARSE_METHODS.has(expr.callee.property.name)) return null;

  if (expr.callee.object.type === 'Identifier') {
    const fields = schemas.get(expr.callee.object.name);
    if (fields) return { shape: fields, confidence: 'high', source: 'literal' };
  }

  const inline = extractZodObjectFields(expr.callee.object);
  if (inline) return { shape: inline, confidence: 'high', source: 'literal' };
  return null;
}

function objectExpressionToShapeFields(obj) {
  const fields = [];
  for (const prop of obj.properties) {
    if (prop.type !== 'Property') continue;
    const name = propertyKeyName(prop.key);
    if (!name) continue;
    const field = { name, type: literalType(prop.value), required: true, confidence: 'low' };
    // Capture pre-determined string values so they can surface as descriptions/examples
    if (prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
      field.example = prop.value.value;
    }
    fields.push(field);
  }
  return fields;
}

function literalType(node) {
  if (node.type === 'Literal') {
    if (node.value === null) return 'null';
    return typeof node.value;
  }
  if (node.type === 'ArrayExpression')  return 'array';
  if (node.type === 'ObjectExpression') return 'object';
  if (node.type === 'TemplateLiteral')  return 'string';
  if (node.type === 'Identifier' && (node.name === 'undefined' || node.name === 'null')) return node.name;
  return 'unknown';
}

// ---------- FormData body detection ----------

function findFormDataFields(fn) {
  const fields        = [];
  const seen          = new Set();
  const reqParamNames = new Set(['req', 'request']);

  if (fn.params.length > 0) {
    const first = fn.params[0];
    if (first.type === 'Identifier') reqParamNames.add(first.name);
  }

  // Pass 1: collect variables that hold formData
  const formDataVars = new Set();
  walk(fn.body, node => {
    if (node.type !== 'VariableDeclaration') return;
    for (const decl of node.declarations) {
      if (!decl.init || decl.id.type !== 'Identifier') continue;
      if (isFormDataExpr(decl.init, reqParamNames)) formDataVars.add(decl.id.name);
    }
  });

  if (formDataVars.size === 0) return [];

  // Pass 2: collect .get('key') / .getAll('key') calls on those variables
  walk(fn.body, node => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      (node.callee.property.name === 'get' || node.callee.property.name === 'getAll') &&
      node.callee.object.type === 'Identifier' &&
      formDataVars.has(node.callee.object.name) &&
      node.arguments[0]?.type === 'Literal' &&
      typeof node.arguments[0].value === 'string'
    ) {
      const key = node.arguments[0].value;
      if (!seen.has(key)) {
        seen.add(key);
        fields.push({
          name:       key,
          type:       node.callee.property.name === 'getAll' ? 'string[]' : 'string',
          required:   true,
          confidence: 'medium',
        });
      }
    }
  });

  return fields;
}

function isFormDataExpr(expr, reqParamNames) {
  // unwrap: await request.formData()
  if (expr.type === 'AwaitExpression' && expr.argument.type === 'CallExpression') {
    return isFormDataExpr(expr.argument, reqParamNames);
  }
  // request.formData()
  return (
    expr.type === 'CallExpression' &&
    expr.callee.type === 'MemberExpression' &&
    expr.callee.property.type === 'Identifier' &&
    expr.callee.property.name === 'formData' &&
    expr.callee.object.type === 'Identifier' &&
    reqParamNames.has(expr.callee.object.name)
  );
}

// ---------- Body usage detection ----------

function isBodyExpr(expr, reqParamNames) {
  if (
    expr.type === 'MemberExpression' && !expr.computed &&
    expr.property.type === 'Identifier' && expr.property.name === 'body' &&
    expr.object.type === 'Identifier' && reqParamNames.has(expr.object.name)
  ) return true;

  if (expr.type === 'AwaitExpression' && expr.argument.type === 'CallExpression') {
    const c = expr.argument.callee;
    if (
      c.type === 'MemberExpression' && !c.computed &&
      c.property.type === 'Identifier' && c.property.name === 'json' &&
      c.object.type === 'Identifier' && reqParamNames.has(c.object.name)
    ) return true;
  }

  if (expr.type === 'CallExpression' && expr.callee.type === 'MemberExpression') {
    const c = expr.callee;
    if (
      !c.computed &&
      c.property.type === 'Identifier' && c.property.name === 'json' &&
      c.object.type === 'Identifier' && reqParamNames.has(c.object.name)
    ) return true;
  }
  return false;
}

function isBodyMember(obj, reqParamNames, bodyVars) {
  if (
    obj.type === 'MemberExpression' && !obj.computed &&
    obj.property.type === 'Identifier' && obj.property.name === 'body' &&
    obj.object.type === 'Identifier' && reqParamNames.has(obj.object.name)
  ) return true;
  if (obj.type === 'Identifier' && bodyVars.has(obj.name)) return true;
  return false;
}

// ---------- Helpers ----------

function propertyKeyName(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && (typeof key.value === 'string' || typeof key.value === 'number')) {
    return String(key.value);
  }
  return null;
}

function walk(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    visit(node);
    for (const key in node) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === 'object' && 'type' in item) stack.push(item);
        }
      } else if (typeof value === 'object' && 'type' in value) {
        stack.push(value);
      }
    }
  }
}

// ---------- Query param detection ----------

/**
 * Walk a handler function and collect query parameter names.
 * Handles:
 *   - Next.js: searchParams.get('key'), request.nextUrl.searchParams.get('key'),
 *              const { page } = searchParams, async fn(req, { searchParams })
 *   - Express:  req.query.key, req.query['key'], const { page } = req.query
 * @param {object} fn  AST function node
 * @returns {Array<{ name: string, type: string }>}
 */
function findQueryParams(fn) {
  const params         = [];
  const seen           = new Set();
  const reqParamNames  = new Set(['req', 'request']);
  const searchParamsVars = new Set(['searchParams']);
  const queryVars      = new Set();

  // Collect request param name from fn signature
  if (fn.params.length > 0) {
    const first = fn.params[0];
    if (first.type === 'Identifier') reqParamNames.add(first.name);
  }

  // Next.js page components: async function Page(props, { searchParams })
  // or GET(request, context) where context is destructured
  if (fn.params.length > 1) {
    const second = fn.params[1];
    if (second.type === 'ObjectPattern') {
      for (const prop of second.properties) {
        if (
          prop.type === 'Property' &&
          prop.key.type === 'Identifier' &&
          prop.key.name === 'searchParams' &&
          prop.value.type === 'Identifier'
        ) {
          searchParamsVars.add(prop.value.name);
        }
      }
    }
  }

  // Pass 1: collect variable aliases so order of declaration doesn't matter
  walk(fn.body, node => {
    if (node.type !== 'VariableDeclaration') return;
    for (const decl of node.declarations) {
      if (!decl.init) continue;

      // const searchParams = request.nextUrl.searchParams
      // const sp = someUrl.searchParams
      if (
        decl.id.type === 'Identifier' &&
        decl.init.type === 'MemberExpression' &&
        decl.init.property.type === 'Identifier' &&
        decl.init.property.name === 'searchParams'
      ) {
        searchParamsVars.add(decl.id.name);
      }

      // const { searchParams } = request.nextUrl
      if (
        decl.id.type === 'ObjectPattern' &&
        decl.init.type === 'MemberExpression' &&
        decl.init.property.type === 'Identifier' &&
        decl.init.property.name === 'nextUrl'
      ) {
        for (const prop of decl.id.properties) {
          if (
            prop.type === 'Property' &&
            prop.key.type === 'Identifier' &&
            prop.key.name === 'searchParams' &&
            prop.value.type === 'Identifier'
          ) {
            searchParamsVars.add(prop.value.name);
          }
        }
      }

      // const query = req.query
      if (
        decl.id.type === 'Identifier' &&
        decl.init.type === 'MemberExpression' &&
        decl.init.property.type === 'Identifier' &&
        decl.init.property.name === 'query' &&
        decl.init.object.type === 'Identifier' &&
        reqParamNames.has(decl.init.object.name)
      ) {
        queryVars.add(decl.id.name);
      }
    }
  });

  // Pass 2: collect actual accesses
  walk(fn.body, node => {
    // searchParams.get('key')
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'get' &&
      node.callee.object.type === 'Identifier' &&
      searchParamsVars.has(node.callee.object.name) &&
      node.arguments[0]?.type === 'Literal' &&
      typeof node.arguments[0].value === 'string'
    ) {
      const key = node.arguments[0].value;
      if (!seen.has(key)) { seen.add(key); params.push({ name: key, type: 'string' }); }
      return;
    }

    // req.query.key
    if (
      node.type === 'MemberExpression' &&
      !node.computed &&
      node.property.type === 'Identifier' &&
      node.object.type === 'MemberExpression' &&
      node.object.property.type === 'Identifier' &&
      node.object.property.name === 'query' &&
      node.object.object.type === 'Identifier' &&
      reqParamNames.has(node.object.object.name)
    ) {
      const key = node.property.name;
      if (!seen.has(key)) { seen.add(key); params.push({ name: key, type: 'string' }); }
      return;
    }

    // req.query['key']
    if (
      node.type === 'MemberExpression' &&
      node.computed &&
      node.property.type === 'Literal' &&
      typeof node.property.value === 'string' &&
      node.object.type === 'MemberExpression' &&
      node.object.property.type === 'Identifier' &&
      node.object.property.name === 'query' &&
      node.object.object.type === 'Identifier' &&
      reqParamNames.has(node.object.object.name)
    ) {
      const key = String(node.property.value);
      if (!seen.has(key)) { seen.add(key); params.push({ name: key, type: 'string' }); }
      return;
    }

    // const { page, limit } = req.query  or  const { page } = query
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) {
        if (!decl.init || decl.id.type !== 'ObjectPattern') continue;
        const isQuery =
          (decl.init.type === 'MemberExpression' &&
           decl.init.property.type === 'Identifier' &&
           decl.init.property.name === 'query' &&
           decl.init.object.type === 'Identifier' &&
           reqParamNames.has(decl.init.object.name)) ||
          (decl.init.type === 'Identifier' && queryVars.has(decl.init.name));

        if (!isQuery) continue;
        for (const prop of decl.id.properties) {
          if (prop.type !== 'Property') continue;
          const keyName = propertyKeyName(prop.key);
          if (!keyName || seen.has(keyName)) continue;
          seen.add(keyName);
          params.push({ name: keyName, type: 'string' });
        }
      }
    }
  });

  return params;
}

module.exports = {
  parseSource,
  inferSchemasFromAst,
  inferSchemasFromFunction,
  buildSchemaMap,
  collectZodSchemas,
  findBodyFromUsage,
  findQueryParams,
  findAllResponseShapes,
  pickPrimaryResponse,
  findFunctionInAst,
  extractZodObjectFieldsFromExpr,
  walk,
  EMPTY_BODY,
  EMPTY_RESPONSE,
};