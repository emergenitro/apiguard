'use strict';

const path = require('path');
const { scanWorkspace }             = require('../scanner');
const { readConfig, routeKey }      = require('../config');

const METHOD_COLOR = {
  GET:    '\x1b[34m',
  POST:   '\x1b[32m',
  PUT:    '\x1b[33m',
  PATCH:  '\x1b[33m',
  DELETE: '\x1b[31m',
};
const RESET  = '\x1b[0m';
const DIM    = '\x1b[2m';
const STRIKE = '\x1b[9m';

async function list(options) {
  const root   = path.resolve(options.root || process.cwd());
  const config = readConfig(root);
  const excluded = new Set(config.excluded || []);

  console.log(`Scanning ${root}...\n`);

  let routes;
  try {
    routes = await scanWorkspace(root);
  } catch (err) {
    console.error('Scan failed:', err.message);
    process.exit(1);
  }

  if (routes.length === 0) {
    console.log('No routes found.');
    return;
  }

  const byFramework = {};
  for (const r of routes) {
    (byFramework[r.framework] ??= []).push(r);
  }

  let totalActive = 0;

  for (const [fw, fwRoutes] of Object.entries(byFramework)) {
    console.log(`  ${DIM}[${fw}]${RESET}`);

    const sorted = fwRoutes
      .slice()
      .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

    for (const r of sorted) {
      const key        = routeKey(r.method, r.path);
      const isExcluded = excluded.has(key);
      const color      = METHOD_COLOR[r.method] ?? '';
      const rel        = path.relative(root, r.sourceFile);

      if (isExcluded) {
        console.log(`    ${DIM}${STRIKE}${r.method.padEnd(6)} ${r.path}${RESET}  ${DIM}(excluded)${RESET}`);
      } else {
        totalActive++;
        console.log(`    ${color}${r.method.padEnd(6)}${RESET} ${r.path}`);
      }
      console.log(`    ${DIM}       ${rel}:${r.sourceLine}${RESET}`);
    }

    console.log();
  }

  const totalExcluded = routes.length - totalActive;
  console.log(`${totalActive} active route(s)${totalExcluded > 0 ? `, ${totalExcluded} excluded` : ''}`);
  if (totalExcluded > 0) {
    console.log(`${DIM}Run \`apiguard include "<METHOD> <path>"\` to re-include a route.${RESET}`);
  }
}

module.exports = { list };
