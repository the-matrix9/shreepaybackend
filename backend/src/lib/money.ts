/**
 * Money helpers. All amounts are BigInt paise internally. No floating point math anywhere.
 * Input rupees are parsed from their decimal *string* form so 19.99 never becomes 1998.9999.
 */
const RUPEES_RE = /^(\d{1,9})(?:\.(\d{1,2}))?$/;

export function parseRupeesToPaise(input: string | number): bigint | null {
  const s = typeof input === 'number' ? (Number.isFinite(input) ? String(input) : '') : input.trim();
  const m = RUPEES_RE.exec(s);
  if (!m) return null; // rejects negatives, exponents (1e21), NaN, >2 decimals, absurd sizes
  const rupees = BigInt(m[1]);
  const paise = BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return rupees * 100n + paise;
}

export function paiseToRupeesString(p: bigint): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** For display/JSON only (never fed back into arithmetic). */
export const paiseToRupeesNumber = (p: bigint): number => Number(paiseToRupeesString(p));
export const paiseToNumber = (p: bigint): number => Number(p);
