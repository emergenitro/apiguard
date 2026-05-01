'use strict';

const path = require('path');
const { readConfig, writeConfig, normalizeRouteArg } = require('../config');

function include(route, options) {
  const root   = path.resolve(options.root || process.cwd());
  const config = readConfig(root);
  const key    = normalizeRouteArg(route);

  if (!config.excluded || !config.excluded.includes(key)) {
    console.log(`Not in exclusion list: ${key}`);
    console.log(`Run \`apiguard list\` to see all routes and their exclusion status.`);
    return;
  }

  config.excluded = config.excluded.filter(e => e !== key);
  writeConfig(root, config);
  console.log(`Included: ${key}`);
  console.log(`Run \`apiguard generate\` to regenerate openapi.json with this route.`);
}

module.exports = { include };
