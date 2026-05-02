<div align="center">

<h1>apiguard-cli</h1>

<p>Auto-generate OpenAPI specs from your source code.<br>No annotations. No decorators. No config. Just point it at your project.</p>

<p>
  <a href="https://www.npmjs.com/package/apiguard-cli"><img src="https://img.shields.io/npm/v/apiguard-cli?style=flat-square&color=crimson" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/apiguard-cli"><img src="https://img.shields.io/npm/dm/apiguard-cli?style=flat-square&color=orange" alt="npm downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/apiguard-cli?style=flat-square&color=blue" alt="license" /></a>
</p>

</div>

---

## Why

Writing OpenAPI specs by hand is tedious. Littering your codebase with decorators just to get docs is messy. `apiguard-cli` scans your existing source files, detects your framework, and spits out a complete OpenAPI spec without touching a single line of your code.

## Install

```bash
npm install -D apiguard-cli
```

## Quick start

```bash
npx apiguard generate                     # → openapi.json
npx apiguard generate --format yaml       # → openapi.yaml
npx apiguard generate -o docs/api.json    # custom output path
npx apiguard generate --dry-run           # print to stdout, don't write
npx apiguard list                         # see all detected routes
npx apiguard exclude "DELETE /api/admin/reset"
npx apiguard include "GET /api/internal/health"
```

## Supported frameworks

| Framework | Routes | Body schemas | Query params | Response shapes |
|---|---|---|---|---|
| **Next.js** (App + Pages Router) | ✅ | Zod · FormData · destructuring | ✅ | ✅ All status codes |
| **Express** | ✅ | Zod · destructuring | ✅ | ✅ All status codes |
| **Flask** | ✅ + Blueprint prefix resolution | Pydantic · `request.get_json()` | ✅ | — |
| **FastAPI** | ✅ | Pydantic · body usage | ✅ Typed params | — |

> Flask and FastAPI schema inference requires **Python 3** on your `PATH`. Routes are still detected without it — just without schema info.

## What gets inferred

### Body schemas

| Source | Confidence | Example |
|---|---|---|
| Zod `.parse()` / `.safeParse()` | High | `z.object({ name: z.string() }).parse(req.body)` |
| Pydantic model param | High | `def create(payload: CreateUser):` |
| `request.formData()` | Medium | `const id = formData.get('id')` |
| `req.body` destructuring | Medium | `const { name, email } = req.body` |
| `request.get_json()` usage | Medium | `data = request.get_json(); data['name']` |

FormData fields detected via `.get('key')` get `multipart/form-data` as the content type. `.getAll('key')` fields are typed as `string[]`.

### Response shapes

Multiple status codes are detected per handler. For each `Response.json()`, `NextResponse.json()`, `res.json()`, or `new Response(JSON.stringify(...), { status })` call, apiguard extracts the status code, the response shape, and the description when the message is a string literal.

So this:

```ts
return NextResponse.json({ error: 'Not found' }, { status: 404 });
return NextResponse.json({ message: 'Created' }, { status: 201 });
```

Produces two separate response entries in the OpenAPI output with the correct descriptions and shapes.

### Flask Blueprint prefix resolution

apiguard pre-scans all Python files to resolve Blueprint URL prefixes, including nested chains of arbitrary depth:

```python
# events.py
events_bp = Blueprint("events_bp", __name__, url_prefix="/events")

@events_bp.route("/verify", methods=["POST"])
def verify(): ...
# → POST /events/verify ✓
```

```python
# app/__init__.py
api_bp.register_blueprint(v1_bp, url_prefix="/v1")
app.register_blueprint(api_bp, url_prefix="/api")
# v1_bp routes → /api/v1/... ✓
```

Prefixes from `register_blueprint()` override inline `url_prefix` when both are present, matching Flask's actual behaviour.

## Config file

`.apiguard.json` lives at your project root and is committed to source control. It stores the exclusion list plus optional OpenAPI metadata written into the generated spec.

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
      source: 'zod',  // 'zod' | 'pydantic' | 'formdata' | 'destructure' | 'none'
      fields: [
        { name: 'email', type: 'string', required: true, confidence: 'high' }
      ]
    }
  },
  responses: [
    { status: 200, shape: [...], description: 'User created' },
    { status: 400, shape: [...], description: 'Email already exists' },
    { status: 401, shape: [...], description: 'Unauthorized' }
  ]
}
```

## CLI reference

### `apiguard generate`

| Flag | Default | Description |
|---|---|---|
| `-o, --output <path>` | `openapi.json` / `openapi.yaml` | Output file path |
| `-f, --format <format>` | `json` | `json` or `yaml` |
| `--dry-run` | — | Print to stdout instead of writing a file |
| `-r, --root <path>` | `cwd` | Workspace root to scan |

### `apiguard list`

Lists every detected route grouped by framework with colour-coded HTTP methods. Shows which routes are currently excluded.

```bash
npx apiguard list
npx apiguard list -r ./packages/api
```

### `apiguard exclude / include`

```bash
npx apiguard exclude "DELETE /api/admin/reset"   # adds to .apiguard.json exclusion list
npx apiguard include "DELETE /api/admin/reset"   # removes from exclusion list
```

## Known limitations

- **Express router mounting** (`app.use('/api', router)`) isn't resolved — routes show their bare paths without the mount prefix.
- **Nested Pydantic/Zod schemas** aren't recursively expanded. A field typed as another model shows the class name as its type.
- **Flask/FastAPI prefixes set outside the scanned workspace** won't be picked up.
- **Dynamic route paths** built from runtime variables can't be statically detected.
- **TypeScript generics and conditional types** in response shapes resolve to `unknown`.

The first two are actively being worked on.

## Contributing

Issues, framework requests, and detection pattern ideas are all welcome. If you find it useful, a ⭐ on the repo goes a long way!

## Links

- [npm](https://www.npmjs.com/package/apiguard-cli)
- [GitHub](https://github.com/emergenitro/apiguard)