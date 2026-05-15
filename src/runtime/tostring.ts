export function tostring(value: unknown): string {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf';
    // Lua prints integers without trailing .0; doubles use %.14g format.
    if (Number.isInteger(value)) return value.toString();
    return formatNumber(value);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'function') return `function: ${anonAddr(value)}`;
  if (typeof value === 'object') {
    const obj = value as { __tostring?: () => string; toString?: () => string };
    if (typeof obj.__tostring === 'function') return obj.__tostring();
    if (Array.isArray(value)) return `table: ${anonAddr(value)}`;
    if (typeof obj.toString === 'function' && obj.toString !== Object.prototype.toString) {
      const raw = obj.toString();
      // Roblox Instances use a stable UID for JS object-key coercion. Lua-side
      // `tostring(part)` should yield the current Name, like Roblox.
      const idx = raw.indexOf('\x01');
      if (idx >= 0) {
        const name = (value as { Name?: unknown }).Name;
        return typeof name === 'string' ? name : raw.slice(0, idx);
      }
      return raw;
    }
    return `table: ${anonAddr(value)}`;
  }
  return String(value);
}

export function tonumber(value: unknown, base?: number): number | undefined {
  if (typeof value === 'number') {
    if (base !== undefined && base !== 10) return undefined;
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (base !== undefined) {
    if (base < 2 || base > 36 || !Number.isInteger(base)) return undefined;
    const parsed = parseInt(trimmed, base);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  // Decimal / hex / inf — match Lua's permissive parser.
  if (/^[+-]?0[xX]/.test(trimmed)) {
    const hex = parseInt(trimmed, 16);
    return Number.isNaN(hex) ? undefined : hex;
  }
  const num = Number(trimmed);
  return Number.isNaN(num) ? undefined : num;
}

function formatNumber(n: number): string {
  // Lua uses %.14g — JS doesn't have that natively, but toPrecision(14)
  // strips trailing zeros and matches well enough for our purposes.
  return parseFloat(n.toPrecision(14)).toString();
}

const addrCounter = new WeakMap<object, string>();
let nextAddr = 1;
function anonAddr(value: object | ((...args: unknown[]) => unknown)): string {
  const obj = value as object;
  let addr = addrCounter.get(obj);
  if (!addr) {
    addr = `0x${(nextAddr++).toString(16).padStart(8, '0')}`;
    addrCounter.set(obj, addr);
  }
  return addr;
}
