export function squares(nums) {
  if (!Array.isArray(nums)) throw new TypeError("nums must be an array");
  return nums.map((n) => n * n);
}

export function sumSquares(nums) {
  return squares(nums).reduce((a, b) => a + b, 0);
}
