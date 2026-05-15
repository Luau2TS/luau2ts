export function lualen(value: unknown): number {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value).length;
  }
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value && typeof value === 'object') {
    // For string-keyed plain objects (used to represent string-keyed Lua
    // tables), Lua's # returns 0. Same here.
    return 0;
  }
  throw new TypeError(`attempt to get length of a ${typeof value} value`);
}
