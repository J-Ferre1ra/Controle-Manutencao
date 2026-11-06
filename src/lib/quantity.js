/** Parse a quantity formatted with Brazilian or international number separators. */
export function parseNumericQuantity(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  const cleaned = String(value).trim().replace(/[^\d,.-]/g, '');
  if (!cleaned || !/\d/.test(cleaned)) return null;
  const sign = cleaned.startsWith('-') ? '-' : '';
  const unsigned = cleaned.replace(/[+-]/g, '');
  const comma = unsigned.lastIndexOf(',');
  const dot = unsigned.lastIndexOf('.');

  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    const integer = unsigned.slice(0, decimalIndex).replace(/[.,]/g, '');
    const fraction = unsigned.slice(decimalIndex + 1).replace(/[.,]/g, '');
    const result = Number(`${sign}${integer || '0'}.${fraction || '0'}`);
    return Number.isFinite(result) ? result : null;
  }

  const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : '';
  if (!separator) {
    const result = Number(sign + unsigned);
    return Number.isFinite(result) ? result : null;
  }

  const parts = unsigned.split(separator);
  const isGroupedInteger = parts.length > 2 && parts[0].length > 0 && parts.slice(1).every((part) => part.length === 3);
  const finalPart = parts[parts.length - 1];
  const isBrazilianThousands = separator === '.' && parts.length === 2 && parts[0].length <= 3 && finalPart.length === 3 && parts[0] !== '0';
  if (isGroupedInteger || isBrazilianThousands) {
    const result = Number(sign + parts.join(''));
    return Number.isFinite(result) ? result : null;
  }

  const integer = parts.slice(0, -1).join('') || '0';
  const result = Number(`${sign}${integer}.${finalPart}`);
  return Number.isFinite(result) ? result : null;
}
