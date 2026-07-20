import { createHash } from "node:crypto";

const DIGITS = /^\d+$/;

export function compareExactSourceIds(leftValue: string | number, rightValue: string | number) {
  const left = String(leftValue);
  const right = String(rightValue);
  if (left === right) return 0;

  const leftTokens = left.match(/\d+|\D+/g) ?? [left];
  const rightTokens = right.match(/\d+|\D+/g) ?? [right];
  const length = Math.min(leftTokens.length, rightTokens.length);
  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index]!;
    const rightToken = rightTokens[index]!;
    if (leftToken === rightToken) continue;
    if (DIGITS.test(leftToken) && DIGITS.test(rightToken)) {
      const numericOrder = compareDigitTokens(leftToken, rightToken);
      if (numericOrder !== 0) return numericOrder;
      continue;
    }
    return codeUnitCompare(leftToken, rightToken);
  }
  return leftTokens.length - rightTokens.length || codeUnitCompare(left, right);
}

export function sortExactSourceIds(ids: readonly (string | number)[]) {
  return ids.map(String).sort(compareExactSourceIds);
}

export function exactSourceIdHash(ids: readonly (string | number)[]) {
  return createHash("sha256").update(JSON.stringify(sortExactSourceIds(ids))).digest("hex");
}

function compareDigitTokens(left: string, right: string) {
  const normalizedLeft = left.replace(/^0+(?=\d)/, "");
  const normalizedRight = right.replace(/^0+(?=\d)/, "");
  return normalizedLeft.length - normalizedRight.length
    || codeUnitCompare(normalizedLeft, normalizedRight)
    || left.length - right.length;
}

function codeUnitCompare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
