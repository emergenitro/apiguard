'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_FILE   = '.apiguard.json';
const HTTP_METHODS  = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * Read .apiguard.json from the project root.
 * Returns a default config object if the file doesn't exist yet.
 * @param {string} root
 * @returns {{ excluded: string[] }}
 */
function readConfig(root) {
  const configPath = path.join(root, CONFIG_FILE);
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { excluded: [] };
  }
}

/**
 * Write config back to .apiguard.json.
 * @param {string} root
 * @param {{ excluded: string[] }} config
 */
function writeConfig(root, config) {
  const configPath = path.join(root, CONFIG_FILE);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Canonical string key for a route used in the exclusion list.
 * @param {string} method  e.g. "GET"
 * @param {string} routePath  e.g. "/api/users"
 * @returns {string}  e.g. "GET /api/users"
 */
function routeKey(method, routePath) {
  return `${method.toUpperCase()} ${routePath}`;
}

/**
 * Normalize a route argument from the CLI.
 * Accepts "GET /api/users", "get /api/users", or just "/api/users".
 * @param {string} arg
 * @returns {string}
 */
function normalizeRouteArg(arg) {
  const trimmed = arg.trim();
  const upper   = trimmed.toUpperCase();
  for (const m of HTTP_METHODS) {
    if (upper.startsWith(m + ' ')) return upper;
  }
  return trimmed;
}

module.exports = { readConfig, writeConfig, routeKey, normalizeRouteArg };
