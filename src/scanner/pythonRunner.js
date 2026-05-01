'use strict';

const cp     = require('child_process');
const crypto = require('crypto');
const path   = require('path');

const INSPECTOR_PATH = path.join(__dirname, '..', '..', 'resources', 'inspector.py');
const TIMEOUT_MS     = 5000;

let cachedPythonBin = undefined;
const resultCache   = new Map();

async function findPython() {
  if (cachedPythonBin !== undefined) return cachedPythonBin;
  for (const bin of ['python3', 'python']) {
    if (await probeBin(bin)) {
      cachedPythonBin = bin;
      return bin;
    }
  }
  cachedPythonBin = null;
  return null;
}

function probeBin(bin) {
  return new Promise(resolve => {
    const proc = cp.spawn(bin, ['--version'], { stdio: 'ignore' });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', ()   => resolve(false));
  });
}

/**
 * Run inspector.py on `content` and return parsed JSON, or null on failure.
 * Results are cached by MD5 of the content to avoid redundant spawns.
 * @param {string} content
 * @returns {Promise<object|null>}
 */
async function runInspector(content) {
  const hash = crypto.createHash('md5').update(content).digest('hex');
  if (resultCache.has(hash)) return resultCache.get(hash) ?? null;

  const python = await findPython();
  if (!python) { resultCache.set(hash, null); return null; }

  return new Promise(resolve => {
    let stdout    = '';
    let timedOut  = false;

    const proc  = cp.spawn(python, [INSPECTOR_PATH], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resultCache.set(hash, null);
      resolve(null);
    }, TIMEOUT_MS);

    proc.stdout.on('data', chunk => { stdout += chunk.toString(); });

    proc.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) { resultCache.set(hash, null); resolve(null); return; }
      try {
        const result = JSON.parse(stdout);
        resultCache.set(hash, result);
        resolve(result);
      } catch {
        resultCache.set(hash, null);
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      if (!timedOut) { resultCache.set(hash, null); resolve(null); }
    });

    proc.stdin.write(content);
    proc.stdin.end();
  });
}

function clearPythonCache() {
  resultCache.clear();
}

module.exports = { runInspector, clearPythonCache };
