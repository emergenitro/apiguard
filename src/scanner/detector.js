'use strict';

const fs   = require('fs/promises');
const path = require('path');

const NODE_DEPS_TO_FRAMEWORK = {
  next:    'nextjs',
  express: 'express',
};

const PY_REQ_PATTERNS = [
  { pattern: /^\s*flask(\b|[<>=~!])/im,   framework: 'flask' },
  { pattern: /^\s*fastapi(\b|[<>=~!])/im, framework: 'fastapi' },
];

const PY_PYPROJECT_PATTERNS = [
  { pattern: /["']flask["']\s*=/i,   framework: 'flask' },
  { pattern: /["']fastapi["']\s*=/i, framework: 'fastapi' },
  { pattern: /^\s*flask\s*=/im,      framework: 'flask' },
  { pattern: /^\s*fastapi\s*=/im,    framework: 'fastapi' },
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'out',
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.svelte-kit',
  '.cache', 'coverage', '.turbo',
]);

const MAX_WALK_DEPTH = 5;

/**
 * Walk the workspace and detect which frameworks are present.
 * @param {string} workspaceRoot
 * @returns {Promise<Array<{ framework: string, rootDir: string }>>}
 */
async function detectFrameworks(workspaceRoot) {
  const detected = [];
  const seen     = new Set();
  const manifests = await findManifests(workspaceRoot, MAX_WALK_DEPTH);

  for (const file of manifests) {
    const dir     = path.dirname(file);
    const base    = path.basename(file);
    const matches = await readManifest(file, base);

    for (const fw of matches) {
      const key = `${fw}:${dir}`;
      if (!seen.has(key)) {
        seen.add(key);
        detected.push({ framework: fw, rootDir: dir });
      }
    }
  }

  return detected;
}

async function readManifest(file, base) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const out = [];

    if (base === 'package.json') {
      const pkg  = JSON.parse(raw);
      const deps = {
        ...(pkg.dependencies     || {}),
        ...(pkg.devDependencies  || {}),
        ...(pkg.peerDependencies || {}),
      };
      for (const [dep, fw] of Object.entries(NODE_DEPS_TO_FRAMEWORK)) {
        if (deps[dep]) out.push(fw);
      }
    } else if (base === 'requirements.txt') {
      for (const { pattern, framework } of PY_REQ_PATTERNS) {
        if (pattern.test(raw)) out.push(framework);
      }
    } else if (base === 'pyproject.toml') {
      for (const { pattern, framework } of PY_PYPROJECT_PATTERNS) {
        if (pattern.test(raw) && !out.includes(framework)) out.push(framework);
      }
    }

    return out;
  } catch {
    return [];
  }
}

async function findManifests(root, maxDepth) {
  const targets = new Set(['package.json', 'requirements.txt', 'pyproject.toml']);
  const results = [];

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && targets.has(entry.name)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(root, 0);
  return results;
}

module.exports = { detectFrameworks };
