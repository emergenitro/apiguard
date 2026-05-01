import ast
import json
import sys


def unwrap_slice(slice_node):
    if type(slice_node).__name__ == "Index":
        return slice_node.value
    return slice_node


def infer_type(annotation):
    if annotation is None:
        return "unknown"

    if isinstance(annotation, ast.Name):
        mapping = {
            "str": "string",
            "int": "number",
            "float": "number",
            "bool": "boolean",
            "None": "null",
            "Any": "any",
        }
        return mapping.get(annotation.id, annotation.id)

    if isinstance(annotation, ast.Constant):
        if annotation.value is None:
            return "null"
        return type(annotation.value).__name__

    if isinstance(annotation, ast.Attribute):
        return annotation.attr

    if isinstance(annotation, ast.Subscript):
        if not isinstance(annotation.value, ast.Name):
            return "unknown"
        outer = annotation.value.id
        inner_node = unwrap_slice(annotation.slice)

        if outer in ("List", "list"):
            return infer_type(inner_node) + "[]"

        if outer in ("Set", "set", "FrozenSet", "frozenset"):
            return infer_type(inner_node) + "[]"

        if outer == "Optional":
            return infer_type(inner_node)

        if outer in ("Dict", "dict"):
            if isinstance(inner_node, ast.Tuple) and len(inner_node.elts) == 2:
                return "Record<string, " + infer_type(inner_node.elts[1]) + ">"
            return "Record<string, unknown>"

        if outer == "Literal":
            if isinstance(inner_node, ast.Tuple):
                parts = []
                for elt in inner_node.elts:
                    if isinstance(elt, ast.Constant):
                        parts.append(json.dumps(elt.value))
                return " | ".join(parts) if parts else "literal"
            if isinstance(inner_node, ast.Constant):
                return json.dumps(inner_node.value)
            return "literal"

        if outer == "Union":
            if isinstance(inner_node, ast.Tuple):
                parts = []
                for elt in inner_node.elts:
                    is_none = (isinstance(elt, ast.Constant) and elt.value is None) or (
                        isinstance(elt, ast.Name) and elt.id == "None"
                    )
                    if not is_none:
                        parts.append(infer_type(elt))
                return " | ".join(parts) if parts else "unknown"

        if outer in ("Tuple", "tuple"):
            if isinstance(inner_node, ast.Tuple):
                return "[" + ", ".join(infer_type(e) for e in inner_node.elts) + "]"

        return "unknown"

    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        right = annotation.right
        left = annotation.left
        right_none = (isinstance(right, ast.Constant) and right.value is None) or (
            isinstance(right, ast.Name) and right.id == "None"
        )
        left_none = (isinstance(left, ast.Constant) and left.value is None) or (
            isinstance(left, ast.Name) and left.id == "None"
        )
        if right_none:
            return infer_type(left)
        if left_none:
            return infer_type(right)
        return infer_type(left) + " | " + infer_type(right)

    return "unknown"


def is_optional(annotation):
    if annotation is None:
        return False
    if isinstance(annotation, ast.Subscript):
        if isinstance(annotation.value, ast.Name):
            outer = annotation.value.id
            if outer == "Optional":
                return True
            if outer == "Union":
                inner_node = unwrap_slice(annotation.slice)
                if isinstance(inner_node, ast.Tuple):
                    for elt in inner_node.elts:
                        if (isinstance(elt, ast.Constant) and elt.value is None) or (
                            isinstance(elt, ast.Name) and elt.id == "None"
                        ):
                            return True
    if isinstance(annotation, ast.BinOp) and isinstance(annotation.op, ast.BitOr):
        right = annotation.right
        if (isinstance(right, ast.Constant) and right.value is None) or (
            isinstance(right, ast.Name) and right.id == "None"
        ):
            return True
    return False


def collect_base_model_classes(tree):
    all_classes = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        base_names = []
        for base in node.bases:
            if isinstance(base, ast.Name):
                base_names.append(base.id)
            elif isinstance(base, ast.Attribute):
                base_names.append(base.attr)
        all_classes[node.name] = {"bases": base_names, "node": node}

    def is_basemodel(name, depth=0):
        if depth > 3:
            return False
        if name == "BaseModel":
            return True
        if name not in all_classes:
            return False
        return any(is_basemodel(b, depth + 1) for b in all_classes[name]["bases"])

    result = {}
    for name, info in all_classes.items():
        if not any(is_basemodel(b) for b in info["bases"]):
            continue
        fields = []
        for stmt in info["node"].body:
            if not isinstance(stmt, ast.AnnAssign):
                continue
            if not isinstance(stmt.target, ast.Name):
                continue
            field_name = stmt.target.id
            if field_name.startswith("_"):
                continue
            annotation = stmt.annotation
            optional = is_optional(annotation) or stmt.value is not None
            fields.append(
                {
                    "name": field_name,
                    "type": infer_type(annotation),
                    "required": not optional,
                }
            )
        result[name] = fields

    return result


def collect_handlers(tree, base_model_classes):
    handlers = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for arg in node.args.args:
            if arg.annotation is None:
                continue
            ann = arg.annotation
            type_name = None
            if isinstance(ann, ast.Name):
                type_name = ann.id
            elif isinstance(ann, ast.Attribute):
                type_name = ann.attr
            if type_name and type_name in base_model_classes:
                handlers[node.name] = {"body_schema": type_name}
                break
    return handlers


def collect_fastapi_routes(tree):
    routes = []
    http_methods = {"get", "post", "put", "patch", "delete", "api_route"}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call):
                continue
            func = decorator.func
            if not isinstance(func, ast.Attribute):
                continue
            attr = func.attr
            if attr not in http_methods:
                continue
            if not decorator.args:
                continue
            path_arg = decorator.args[0]
            if not isinstance(path_arg, ast.Constant) or not isinstance(
                path_arg.value, str
            ):
                continue
            route_path = path_arg.value

            if attr == "api_route":
                for kw in decorator.keywords:
                    if kw.arg != "methods" or not isinstance(kw.value, ast.List):
                        continue
                    for elt in kw.value.elts:
                        if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                            routes.append(
                                {
                                    "method": elt.value.upper(),
                                    "path": route_path,
                                    "handler": node.name,
                                    "line": node.lineno,
                                }
                            )
            else:
                routes.append(
                    {
                        "method": attr.upper(),
                        "path": route_path,
                        "handler": node.name,
                        "line": node.lineno,
                    }
                )
    return routes


def find_body_from_usage(tree, fn_name):
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name != fn_name:
            continue

        json_vars = set()
        for stmt in ast.walk(node):
            if not isinstance(stmt, ast.Assign):
                continue
            for target in stmt.targets:
                if not isinstance(target, ast.Name):
                    continue
                val = stmt.value
                is_get_json = (
                    isinstance(val, ast.Call)
                    and isinstance(val.func, ast.Attribute)
                    and val.func.attr == "get_json"
                )
                is_json_attr = isinstance(val, ast.Attribute) and val.attr == "json"
                if is_get_json or is_json_attr:
                    json_vars.add(target.id)

        fields = []
        seen = set()
        for stmt in ast.walk(node):
            if isinstance(stmt, ast.Subscript):
                if isinstance(stmt.value, ast.Name) and stmt.value.id in json_vars:
                    sl = unwrap_slice(stmt.slice)
                    if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
                        key = sl.value
                        if key not in seen:
                            seen.add(key)
                            fields.append(
                                {"name": key, "type": "unknown", "required": True}
                            )
            if isinstance(stmt, ast.Call):
                if (
                    isinstance(stmt.func, ast.Attribute)
                    and stmt.func.attr == "get"
                    and isinstance(stmt.func.value, ast.Name)
                    and stmt.func.value.id in json_vars
                    and stmt.args
                    and isinstance(stmt.args[0], ast.Constant)
                    and isinstance(stmt.args[0].value, str)
                ):
                    key = stmt.args[0].value
                    if key not in seen:
                        seen.add(key)
                        fields.append(
                            {"name": key, "type": "unknown", "required": False}
                        )
        return fields

    return []


def collect_query_params(tree, base_model_classes):
    """
    Collect query params for every function in the file.
    - Flask style:   request.args.get('key'), request.args['key']
    - FastAPI style: typed function params that are not path params / body params
    Returns { fn_name: [{ name, type, required }] }
    """
    result = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        params = _query_from_args_usage(node)
        if params:
            result[node.name] = params
    return result


def _query_from_args_usage(fn_node):
    """Detect request.args.get / request.args[key] inside a Flask handler."""
    seen = set()
    params = []

    for stmt in ast.walk(fn_node):
        # request.args.get('key') or request.args.get('key', default)
        if (
            isinstance(stmt, ast.Call)
            and isinstance(stmt.func, ast.Attribute)
            and stmt.func.attr in ("get", "getlist")
            and isinstance(stmt.func.value, ast.Attribute)
            and stmt.func.value.attr == "args"
            and stmt.args
            and isinstance(stmt.args[0], ast.Constant)
            and isinstance(stmt.args[0].value, str)
        ):
            key = stmt.args[0].value
            if key not in seen:
                seen.add(key)
                required = len(stmt.args) < 2 and not stmt.keywords
                params.append({"name": key, "type": "string", "required": required})

        # request.args['key']
        if isinstance(stmt, ast.Subscript):
            if isinstance(stmt.value, ast.Attribute) and stmt.value.attr == "args":
                sl = unwrap_slice(stmt.slice)
                if isinstance(sl, ast.Constant) and isinstance(sl.value, str):
                    key = sl.value
                    if key not in seen:
                        seen.add(key)
                        params.append({"name": key, "type": "string", "required": True})

    return params


def collect_fastapi_query_params(routes_list, tree, base_model_classes):
    """
    For each FastAPI handler, extract typed query params from its function signature.
    A param is a query param when it:
      - Is NOT in the URL path (not a {path_param})
      - Is NOT annotated with a Pydantic BaseModel subclass
      - Is NOT a common injected dependency name
      - Has a type annotation
    Returns { fn_name: [{ name, type, required }] }
    """
    import re

    handler_to_path = {r["handler"]: r["path"] for r in routes_list}
    result = {}

    SKIP_NAMES = {
        "self",
        "cls",
        "request",
        "req",
        "response",
        "db",
        "session",
        "background_tasks",
        "settings",
        "current_user",
    }

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if node.name not in handler_to_path:
            continue

        path_string = handler_to_path[node.name]
        path_params = set(re.findall(r"\{([^}:]+)(?::[^}]+)?\}", path_string))

        n_args = len(node.args.args)
        n_defs = len(node.args.defaults)
        args_with_default = {
            node.args.args[i].arg for i in range(n_args - n_defs, n_args)
        }

        query_params = []
        for arg in node.args.args:
            name = arg.arg
            if name in SKIP_NAMES or name in path_params:
                continue
            if arg.annotation is None:
                continue

            ann = arg.annotation
            type_name = None
            if isinstance(ann, ast.Name):
                type_name = ann.id
            elif isinstance(ann, ast.Attribute):
                type_name = ann.attr
            if type_name and type_name in base_model_classes:
                continue

            required = name not in args_with_default
            query_params.append(
                {
                    "name": name,
                    "type": infer_type(arg.annotation),
                    "required": required,
                }
            )

        if query_params:
            existing = result.get(node.name, [])
            seen_names = {p["name"] for p in existing}
            for qp in query_params:
                if qp["name"] not in seen_names:
                    existing.append(qp)
            if existing:
                result[node.name] = existing

    return result


def main():
    source = sys.stdin.read()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        print(
            json.dumps(
                {
                    "schemas": {},
                    "handlers": {},
                    "routes": [],
                    "bodyUsage": {},
                    "queryParams": {},
                }
            )
        )
        return

    schemas = collect_base_model_classes(tree)
    handlers = collect_handlers(tree, schemas)
    routes = collect_fastapi_routes(tree)

    body_usage = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        fn_name = node.name
        if fn_name in handlers:
            continue
        usage = find_body_from_usage(tree, fn_name)
        if usage:
            body_usage[fn_name] = usage

    query_params = collect_query_params(tree, schemas)
    fastapi_qp = collect_fastapi_query_params(routes, tree, schemas)
    for fn_name, qps in fastapi_qp.items():
        existing = query_params.get(fn_name, [])
        seen_names = {p["name"] for p in existing}
        for qp in qps:
            if qp["name"] not in seen_names:
                existing.append(qp)
        query_params[fn_name] = existing

    print(
        json.dumps(
            {
                "schemas": schemas,
                "handlers": handlers,
                "routes": routes,
                "bodyUsage": body_usage,
                "queryParams": query_params,
            }
        )
    )


if __name__ == "__main__":
    main()
