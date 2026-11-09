export function sumNumbers(arr) {
  return arr.reduce((a, b) => (typeof b === "number" && Number.isFinite(b) ? a + b : a), 0);
}
