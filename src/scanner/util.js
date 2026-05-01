'use strict';

/**
 * Build a blank route object with empty schema fields.
 * @param {string} method
 * @param {string} urlPath
 * @param {string} file
 * @param {number} line
 * @param {string} framework
 */
function makeBlankRoute(method, urlPath, file, line, framework) {
  return {
    method,
    path:       urlPath,
    sourceFile: file,
    sourceLine: line,
    framework,
    params: {
      path:  extractPathParams(urlPath, framework),
      query: [],
      body:  { fields: [], source: 'none' },
    },
    response: {
      shape:      [],
      confidence: 'low',
      source:     'none',
    },
  };
}

/**
 * Extract path parameter names and types from a URL string.
 * @param {string} urlPath
 * @param {string} framework
 * @returns {Array<{ name: string, type: string }>}
 */
function extractPathParams(urlPath, framework) {
  const params = [];

  if (framework === 'nextjs') {
    const re = /\[(\.{0,3})([^\]]+)\]/g;
    let m;
    while ((m = re.exec(urlPath)) !== null) {
      params.push({ name: m[2], type: m[1].length > 0 ? 'string[]' : 'string' });
    }
  } else if (framework === 'flask') {
    const re = /<(?:(\w+):)?(\w+)>/g;
    let m;
    while ((m = re.exec(urlPath)) !== null) {
      params.push({ name: m[2], type: m[1] || 'string' });
    }
  } else if (framework === 'fastapi') {
    const re = /\{([^}:]+)(?::[^}]+)?\}/g;
    let m;
    while ((m = re.exec(urlPath)) !== null) {
      params.push({ name: m[1], type: 'string' });
    }
  } else if (framework === 'express') {
    const re = /:(\w+)/g;
    let m;
    while ((m = re.exec(urlPath)) !== null) {
      params.push({ name: m[1], type: 'string' });
    }
  }

  return params;
}

module.exports = { makeBlankRoute, extractPathParams };
