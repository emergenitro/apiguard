'use strict';

const path = require('path');
const { detectFrameworks }          = require('./detector');
const { scanNextjs, scanSingleFileNextjs } = require('./nextjs');
const { scanFlask,  scanSingleFileFlask }  = require('./flask');
const { scanFastAPI, scanSingleFileFastAPI } = require('./fastapi');
const { scanExpress, scanSingleFileExpress } = require('./express');

/**
 * Scan an entire workspace root and return all detected routes.
 * @param {string} workspaceRoot
 * @returns {Promise<import('./util').Route[]>}
 */
async function scanWorkspace(workspaceRoot) {
  const detected = await detectFrameworks(workspaceRoot);
  const all      = [];

  await Promise.all(
    detected.map(async ({ framework, rootDir }) => {
      let scanned = [];
      if (framework === 'nextjs')  scanned = await scanNextjs(rootDir);
      if (framework === 'flask')   scanned = await scanFlask(rootDir);
      if (framework === 'fastapi') scanned = await scanFastAPI(rootDir);
      if (framework === 'express') scanned = await scanExpress(rootDir);
      all.push(...scanned);
    })
  );

  return dedupe(all);
}

/**
 * Re-scan a single file and return its routes (used for incremental updates).
 * @param {string} workspaceRoot
 * @param {string} filePath
 * @returns {Promise<import('./util').Route[]>}
 */
async function scanFile(workspaceRoot, filePath) {
  const detected = await detectFrameworks(workspaceRoot);
  const all      = [];

  for (const { framework, rootDir } of detected) {
    const normalRoot = rootDir.endsWith(path.sep) ? rootDir : rootDir + path.sep;
    if (!filePath.startsWith(normalRoot) && filePath !== rootDir) continue;

    let routes = [];
    if (framework === 'nextjs')  routes = await scanSingleFileNextjs(filePath, rootDir);
    if (framework === 'flask')   routes = await scanSingleFileFlask(filePath);
    if (framework === 'fastapi') routes = await scanSingleFileFastAPI(filePath);
    if (framework === 'express') routes = await scanSingleFileExpress(filePath, rootDir);
    all.push(...routes);
  }

  return dedupe(all);
}

function dedupe(routes) {
  const seen = new Set();
  return routes.filter(r => {
    const key = `${r.framework}|${r.method}|${r.path}|${r.sourceFile}|${r.sourceLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { scanWorkspace, scanFile, detectFrameworks };
