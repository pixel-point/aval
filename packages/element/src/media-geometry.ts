export function sameAspectRatio(
  leftWidth: number,
  leftHeight: number,
  rightWidth: number,
  rightHeight: number
): boolean {
  if (
    !positiveSafeInteger(leftWidth) ||
    !positiveSafeInteger(leftHeight) ||
    !positiveSafeInteger(rightWidth) ||
    !positiveSafeInteger(rightHeight)
  ) {
    throw new RangeError("media aspect dimensions are invalid");
  }
  return BigInt(leftWidth) * BigInt(rightHeight) ===
    BigInt(rightWidth) * BigInt(leftHeight);
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
