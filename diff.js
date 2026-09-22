export function compareJson(before, after) {
  const changes = [];

  function walk(left, right, path) {
    if (Object.is(left, right)) return;

    const leftObject = left !== null && typeof left === "object";
    const rightObject = right !== null && typeof right === "object";
    const sameContainer = leftObject && rightObject && Array.isArray(left) === Array.isArray(right);

    if (sameContainer) {
      const keys = Array.isArray(left)
        ? Array.from({ length: Math.max(left.length, right.length) }, (_, index) => index)
        : [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();

      for (const key of keys) {
        const childPath = typeof key === "number"
          ? `${path}[${key}]`
          : `${path}.${key}`;
        const hasLeft = Object.hasOwn(left, key);
        const hasRight = Object.hasOwn(right, key);
        if (!hasLeft) changes.push({ type: "added", path: childPath, after: right[key] });
        else if (!hasRight) changes.push({ type: "removed", path: childPath, before: left[key] });
        else walk(left[key], right[key], childPath);
      }
      return;
    }

    changes.push({ type: "changed", path, before: left, after: right });
  }

  walk(before, after, "$ ".trim());
  return changes;
}

export function summarize(changes) {
  return changes.reduce((count, change) => {
    count[change.type] += 1;
    return count;
  }, { added: 0, removed: 0, changed: 0 });
}
