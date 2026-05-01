'use strict';

const path = require('path');
const { readConfig, writeConfig, normalizeRouteArg } = require('../config');

function exclude(route, options) {
  const root   = path.resolve(options.root || process.cwd());
  const config = readConfig(root);
  const key    = normalizeRouteArg(route);

  if (!config.excluded) config.excluded = [];

  if (config.excluded.includes(key)) {
    console.log(`Already excluded: ${key}`);
    return;
  }

  config.excluded.push(key);
  writeConfig(root, config);
  console.log(`Excluded: ${key}`);
  console.log(`Run \`apiguard generate\` to regenerate openapi.json without this route.`);
}

module.exports = { exclude };
