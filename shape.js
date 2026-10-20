// Structural view of a JSON value: every path mapped to the set of types seen there.
// Array items collapse into a single `[]` segment, so `$.items[].id` describes every item.
// Shared by the browser ("Compare structure only") and the drift monitor on the server.

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function childPath(path, key) {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

export function parentPath(path) {
  if (path === "$") return null;
  if (path.endsWith("[]")) return path.slice(0, -2);
  // A quoted key cannot contain an unescaped `["`, so the last one opens the final segment.
  if (path.endsWith('"]')) return path.slice(0, path.lastIndexOf('["'));
  return path.slice(0, path.lastIndexOf("."));
}

export function isDescendant(path, ancestor) {
  return path.length > ancestor.length
    && path.startsWith(ancestor)
    && (path[ancestor.length] === "." || path[ancestor.length] === "[");
}

export function formatTypes(types) {
  return types.join(" | ");
}

export function inferShape(value, { arraySample = 1000 } = {}) {
  const shape = new Map();

  function walk(node, path) {
    const type = typeOf(node);
    if (!shape.has(path)) shape.set(path, new Set());
    shape.get(path).add(type);
    if (type === "object") {
      for (const key of Object.keys(node)) walk(node[key], childPath(path, key));
    } else if (type === "array") {
      for (const item of node.slice(0, arraySample)) walk(item, `${path}[]`);
    }
  }

  walk(value, "$");
  return Object.fromEntries(
    [...shape.keys()].sort().map(path => [path, [...shape.get(path)].sort()])
  );
}

// Ignore patterns are paths where `*` matches one segment name. A pattern also covers
// everything nested below it, so `$.meta` ignores `$.meta.requestId`.
export function compileIgnore(patterns = []) {
  const expressions = patterns.map(pattern => {
    const source = pattern
      .split("*")
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join('[^.\\[]*');
    return new RegExp(`^${source}(?:$|[.\\[])`);
  });
  return path => expressions.some(expression => expression.test(path));
}

export function diffShapes(before, after, { ignore = [] } = {}) {
  const isIgnored = compileIgnore(ignore);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes = [];
  const collapsed = [];

  for (const path of paths) {
    if (isIgnored(path) || collapsed.some(root => isDescendant(path, root))) continue;
    const old = before[path];
    const next = after[path];
    if (!old) {
      changes.push({ type: "added", path, after: formatTypes(next) });
      collapsed.push(path);
    } else if (!next) {
      changes.push({ type: "removed", path, before: formatTypes(old) });
      collapsed.push(path);
    } else if (formatTypes(old) !== formatTypes(next)) {
      changes.push({ type: "changed", path, before: formatTypes(old), after: formatTypes(next) });
    }
  }
  return changes;
}
