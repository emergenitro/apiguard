# apiguard

Auto-detect API routes across frameworks and generate OpenAPI docs with zero config.

## Install

```bash
npm install -D apiguard
```

## Commands

### `apiguard generate`

Scans your project and writes `openapi.json`.

```bash
npx apiguard generate
npx apiguard generate -o docs/api.json   # custom output path
npx apiguard generate -r ./packages/api  # custom root
```

### `apiguard list`

Lists every detected route, grouped by framework. Shows which routes are excluded.

```bash
npx apiguard list
```

### `apiguard exclude <route>`

Adds a route to the exclusion list in `.apiguard.json`. Excluded routes are hidden from `generate` output.

```bash
npx apiguard exclude "GET /api/internal/health"
npx apiguard exclude "DELETE /api/admin/nuke"
```

### `apiguard include <route>`

Re-includes a previously excluded route.

```bash
npx apiguard include "GET /api/internal/health"
```

## Supported frameworks

| Framework | Detection | Route extraction | Body schema | Response shape |
|-----------|-----------|-----------------|-------------|----------------|
| Next.js (App Router) | `package.json` | `app/**/route.ts` exports | Zod (high) / destructuring (medium) | Zod / return literal |
| Next.js (Pages Router) | `package.json` | `pages/api/**` | — | — |
| Express | `package.json` | AST (`app.get`, `router.post`, etc.) | Zod (high) / destructuring (medium) | `res.json` literal |
| Flask | `requirements.txt` / `pyproject.toml` | `@app.route` decorators | Pydantic (high) / `request.get_json()` (medium) | — |
| FastAPI | `requirements.txt` / `pyproject.toml` | `@router.get` decorators | Pydantic (high) / body usage (medium) | — |

> **FastAPI and Flask** body inference requires Python 3 to be available on `PATH`.

## Config file

`apiguard generate` and `apiguard exclude` read/write `.apiguard.json` in your project root. You can commit this file — it just holds the exclusion list.

```json
{
  "excluded": [
    "GET /api/internal/health",
    "DELETE /api/admin/nuke"
  ]
}
```

## Programmatic API

```js
const { scanWorkspace, detectFrameworks } = require('apiguard');

const routes = await scanWorkspace('/path/to/project');
console.log(routes);
// [{ method, path, sourceFile, sourceLine, framework, params, response }, ...]
```
