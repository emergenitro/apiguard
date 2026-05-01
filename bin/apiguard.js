#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const { generate }  = require('../src/commands/generate');
const { list }      = require('../src/commands/list');
const { exclude }   = require('../src/commands/exclude');
const { include }   = require('../src/commands/include');
const { version }   = require('../package.json');

program
  .name('apiguard')
  .description('Auto-detect and visualize API routes across frameworks')
  .version(version);

program
  .command('generate')
  .description('Scan routes and write openapi.json / openapi.yaml')
  .option('-o, --output <path>',   'output file path (default: openapi.json or openapi.yaml)')
  .option('-f, --format <format>', 'output format: json or yaml', 'json')
  .option('--dry-run',             'print to stdout instead of writing a file')
  .option('-r, --root <path>',     'workspace root (defaults to cwd)')
  .action(generate);

program
  .command('list')
  .description('List all detected API routes')
  .option('-r, --root <path>', 'workspace root (defaults to cwd)')
  .action(list);

program
  .command('exclude <route>')
  .description('Exclude a route from generated output  e.g. "GET /api/users"')
  .option('-r, --root <path>', 'workspace root (defaults to cwd)')
  .action((route, opts) => exclude(route, opts));

program
  .command('include <route>')
  .description('Re-include a previously excluded route  e.g. "GET /api/users"')
  .option('-r, --root <path>', 'workspace root (defaults to cwd)')
  .action((route, opts) => include(route, opts));

program.parse();