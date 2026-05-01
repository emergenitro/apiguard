# apiguard

Auto-detect API routes across frameworks and generate OpenAPI docs with zero config. No annotations, no decorators, no setup file — just point it at your project.

## Install

```bash
npm install -D apiguard-cli
```

## Commands

### `apiguard generate`

Scans your project and writes an OpenAPI spec.

```bash
npx apiguard generate                        # → openapi.json
npx apiguard generate --format yaml          # → openapi.yaml
npx apiguard generate -o docs/api.json       # custom output path
npx apiguard generate --dry-run              # print to stdout, don't write
npx apiguard generate -r ./packages/api      # custom workspace root
```

| Flag | Default | Description |
|---|---|---|
| `-o, --output <path>` | `openapi.json` / `openapi.yaml` | Output file path |
| `-f, --format <format>` | `json` | `json` or `yaml` |
| `--dry-run` | — | Print to stdout instead of writing a file |
| `-r, --root <path>` | `cwd` | Workspace root to scan |

---

### `apiguard list`

Lists every detected route grouped by framework, with colour-coded methods. Shows which routes are currently excluded.

```bash
npx apiguard list
npx apiguard list -r ./packages/api
```

---

### `apiguard exclude <route>`

Adds a route to the exclusion list in `.apiguard.json`. Excluded routes are hidden from `generate` output.

```bash
npx apiguard exclude "GET /api/internal/health"
npx apiguard exclude "DELETE /api/admin/reset"
```

---

### `apiguard include <route>`

Re-includes a previously excluded route.

```bash
npx apiguard include "GET /api/internal/health"
```

---

## Supported frameworks

| Framework | Detection | Route extraction | Body schema | Query params | Response shapes |
|---|---|---|---|---|---|
| **Next.js App Router** | `package.json` | `app/**/route.ts` exported functions | Zod · FormData · destructuring | `searchParams.get()` · destructured searchParams | All status codes with descriptions |
| **Next.js Pages Router** | `package.json` | `pages/api/**` default exports | — | — | — |
| **Express** | `package.json` | AST (`app.get`, `router.post`, chained `.route()`) | Zod · destructuring | `req.query.x` · `const { x } = req.query` | All status codes with descriptions |
| **Flask** | `requirements.txt` / `pyproject.toml` | `@bp.route` · `@bp.get` decorators + **Blueprint prefix resolution** | Pydantic · `request.get_json()` | `request.args.get()` · `request.args['key']` | — |
| **FastAPI** | `requirements.txt` / `pyproject.toml` | `@router.get` / `@router.post` decorators | Pydantic · body usage | Typed function params | — |

> Flask and FastAPI body/query inference requires **Python 3** on your `PATH`. Routes are still detected without it — just without schema info.

---

## What gets inferred

### Body schemas

| Source | Confidence | Example |
|---|---|---|
| Zod `.parse()` / `.safeParse()` | High | `z.object({ name: z.string() }).parse(req.body)` |
| Pydantic model param | High | `def create(payload: CreateUser):` |
| `request.formData()` | Medium | `const id = formData.get('id')` |
| `req.body` destructuring | Medium | `const { name, email } = req.body` |
| `request.get_json()` usage | Medium | `data = request.get_json(); data['name']` |

FormData fields detected via `.get('key')` get `multipart/form-data` as the OpenAPI content type. `.getAll('key')` fields are typed as `string[]`.

### Query params

| Pattern | Framework |
|---|---|
| `searchParams.get('q')` | Next.js App Router |
| `const { page } = searchParams` | Next.js |
| `const { searchParams } = request.nextUrl` | Next.js |
| `req.query.page` · `req.query['page']` | Express |
| `const { page, limit } = req.query` | Express |
| `request.args.get('q')` · `request.args['q']` | Flask |
| Typed function params: `def search(q: str, limit: int = 10):` | FastAPI |

### Response shapes

Multiple status codes are detected per handler. For each `Response.json()`, `NextResponse.json()`, `res.json()`, or `new Response(JSON.stringify(...), { status })` call, apiguard extracts:

- The **status code** from the second argument
- The **response shape** (field names and types)  
- The **description** when the message is a string literal (e.g. `{ error: 'Unauthorized' }` → description: `"Unauthorized"`)
- **Examples** for each string literal field

This means an endpoint like:

```ts
return NextResponse.json({ error: 'Not found' }, { status: 404 });
return NextResponse.json({ message: 'Created' }, { status: 201 });
```

Produces two separate response entries in the OpenAPI output with the correct descriptions.

### Flask Blueprint prefixes

apiguard pre-scans all Python files to resolve Blueprint URL prefixes — including nested blueprints:

```python
# events.py
events_bp = Blueprint("events_bp", __name__, url_prefix="/events")

@events_bp.route("/verify", methods=["POST"])
def verify():  ...
# → POST /events/verify ✓
```

```python
# app/__init__.py
api_bp.register_blueprint(v1_bp, url_prefix="/v1")
app.register_blueprint(api_bp, url_prefix="/api")
# v1_bp routes → /api/v1/... ✓
```

Prefixes from `register_blueprint()` override inline `url_prefix` when both are present, matching Flask's actual behaviour. Chains of arbitrary depth are resolved iteratively.

---

## Config file

`.apiguard.json` lives in your project root and is committed to source control. It stores the exclusion list plus optional OpenAPI metadata that gets written into the generated spec.

```json
{
  "title": "My API",
  "version": "2.1.0",
  "description": "Internal service API",
  "servers": [
    { "url": "https://api.example.com", "description": "Production" },
    { "url": "http://localhost:3000",   "description": "Local" }
  ],
  "excluded": [
    "GET /api/internal/health",
    "DELETE /api/admin/reset"
  ]
}
```

All fields except `excluded` are optional. Without them, `generate` defaults to `title: "API"` and `version: "1.0.0"`.

---

## Programmatic API

```js
const { scanWorkspace, scanFile, detectFrameworks } = require('apiguard-cli');

// Scan everything
const routes = await scanWorkspace('/path/to/project');

// Re-scan a single file (for incremental updates)
const routes = await scanFile('/path/to/project', '/path/to/project/src/routes/users.ts');

// Just detect frameworks
const detected = await detectFrameworks('/path/to/project');
// → [{ framework: 'nextjs', rootDir: '/path/to/project' }]
```

Each route object looks like:

```js
{
  method:     'POST',
  path:       '/api/users',
  sourceFile: '/path/to/project/src/app/api/users/route.ts',
  sourceLine: 12,
  framework:  'nextjs',
  params: {
    path:  [{ name: 'id', type: 'string' }],
    query: [{ name: 'page', type: 'string' }],
    body:  {
      source: 'zod',           // 'zod' | 'pydantic' | 'formdata' | 'destructure' | 'none'
      fields: [
        { name: 'email', type: 'string', required: true, confidence: 'high' }
      ]
    }
  },
  response: {                  // primary (200) response
    shape:      [{ name: 'id', type: 'string', required: true, confidence: 'low' }],
    confidence: 'low',
    source:     'literal'
  },
  responses: [                 // all detected status codes
    { status: 200, shape: [...], description: 'User created' },
    { status: 400, shape: [...], description: 'Email already exists' },
    { status: 401, shape: [...], description: 'Unauthorized' }
  ]
}
```

---

## Known limitations

- **Flask/FastAPI router prefixes from `include_router` / `register_blueprint` at the app level** are resolved only when the call is visible in a `.py` file within the scanned workspace. Prefixes set outside the workspace (e.g. in a parent package) won't be picked up.
- **Express router mounting** (`app.use('/api', router)`) isn't resolved — routes on that router show their bare paths. The path param and body inference still works, just without the mount prefix.
- **Nested Pydantic/Zod schemas** aren't recursively expanded. A field typed as another model class shows the class name as its type.
- **Dynamic route paths** built from variables at runtime can't be statically detected.
- **TypeScript generics and conditional types** in response shapes aren't resolved — the type shows as `unknown`.

---

## Project structure

```
apiguard/
├── bin/
│   └── apiguard.js          CLI entry point
├── src/
│   ├── config.js            .apiguard.json read/write
│   ├── commands/
│   │   ├── generate.js      apiguard generate
│   │   ├── list.js          apiguard list
│   │   ├── exclude.js       apiguard exclude
│   │   └── include.js       apiguard include
│   └── scanner/
│       ├── index.js         orchestrator
│       ├── detector.js      framework detection from manifests
│       ├── nextjs.js        App Router + Pages Router
│       ├── express.js       Express AST scanner
│       ├── flask.js         Flask decorator scanner + Blueprint resolver
│       ├── fastapi.js       FastAPI decorator scanner
│       ├── schemaInfer.js   Zod / FormData / response inference
│       ├── importResolver.js cross-file schema imports
│       ├── pythonRunner.js  Python subprocess for Pydantic
│       └── util.js          shared helpers
└── resources/
    └── inspector.py         Python AST inspector (Pydantic + query params)
```