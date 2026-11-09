export function first(items) {
  return items[0];
}

function keyOf(keyFn) {
  return typeof keyFn === "function" ? keyFn : (item) => item[keyFn];
}

export function groupBy(items, keyFn) {
  const k = keyOf(keyFn);
  const out = {};
  for (const item of items) {
    (out[k(item)] ??= []).push(item);
  }
  return out;
}

export function countBy(items, keyFn) {
  const k = keyOf(keyFn);
  const out = {};
  for (const item of items) {
    out[k(item)] = (out[k(item)] ?? 0) + 1;
  }
  return out;
}
