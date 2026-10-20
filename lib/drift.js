import { compileIgnore, formatTypes, inferShape, isDescendant, parentPath } from "../shape.js";

// A field must be absent from this many consecutive responses before it counts as removed.
// Optional fields and sampled arrays would otherwise raise an alert on every other check.
export const MISSING_THRESHOLD = 3;
export const MAX_PATHS = 10_000;

export function isBreaking(change) {
  return change.type !== "added";
}

// Learns an endpoint's schema as the union of every response it has seen, and reports
// what is new: fields that appear, types a field has never had before (a `null` showing
// up is the classic one), and fields that stop appearing for several checks in a row.
export function observe(state, value, { ignore = [], missingThreshold = MISSING_THRESHOLD } = {}) {
  const isIgnored = compileIgnore(ignore);
  const shape = Object.fromEntries(
    Object.entries(inferShape(value)).filter(([path]) => !isIgnored(path))
  );
  if (Object.keys(shape).length > MAX_PATHS) {
    throw new Error(`Response has more than ${MAX_PATHS} distinct fields. Add ignore paths for dynamic sections.`);
  }
  if (!state) return { state: { baseline: shape, missing: {} }, changes: [], baselineCaptured: true };

  const baseline = { ...state.baseline };
  const missing = { ...state.missing };
  for (const path of Object.keys(baseline)) {
    if (isIgnored(path)) {
      delete baseline[path];
      delete missing[path];
    }
  }

  const changes = [];
  const addedRoots = [];
  for (const [path, types] of Object.entries(shape)) {
    delete missing[path];
    const known = baseline[path];
    if (!known) {
      if (!addedRoots.some(root => isDescendant(path, root))) {
        changes.push({ type: "added", path, after: formatTypes(types) });
        addedRoots.push(path);
      }
      baseline[path] = types;
      continue;
    }
    const newTypes = types.filter(type => !known.includes(type));
    if (newTypes.length) {
      const merged = [...known, ...newTypes].sort();
      changes.push({ type: "changed", path, before: formatTypes(known), after: formatTypes(merged) });
      baseline[path] = merged;
    }
  }

  const removedRoots = [];
  for (const path of Object.keys(baseline).sort()) {
    if (shape[path] || removedRoots.some(root => isDescendant(path, root))) continue;
    if (!countsAsMissing(path, shape)) continue;
    missing[path] = (missing[path] ?? 0) + 1;
    if (missing[path] >= missingThreshold) {
      changes.push({ type: "removed", path, before: formatTypes(baseline[path]) });
      removedRoots.push(path);
    }
  }
  for (const root of removedRoots) {
    for (const path of Object.keys(baseline)) {
      if (path === root || isDescendant(path, root)) {
        delete baseline[path];
        delete missing[path];
      }
    }
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { state: { baseline, missing }, changes, baselineCaptured: false };
}

// A field only counts as missing when its parent object was present in this response.
// An empty array or an absent parent says nothing about the field itself.
function countsAsMissing(path, shape) {
  if (path.endsWith("[]")) return false;
  return shape[parentPath(path)]?.includes("object") ?? false;
}

export function summarizeDrift(changes) {
  const removed = changes.filter(change => change.type === "removed").length;
  const changed = changes.filter(change => change.type === "changed").length;
  const added = changes.filter(change => change.type === "added").length;
  return [
    removed && `${removed} removed`,
    changed && `${changed} new ${changed === 1 ? "type" : "types"}`,
    added && `${added} added`
  ].filter(Boolean).join(" · ");
}
