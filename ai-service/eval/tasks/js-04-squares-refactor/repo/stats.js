export function sumSquares(nums) {
  var total = 0;
  for (var i = 0; i < nums.length; i++) {
    total += nums[i] * nums[i];
  }
  return total;
}
