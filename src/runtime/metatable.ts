const RAW_TARGET = Symbol.for('rbx-web.luaRawTarget');

const metatables = new WeakMap<object, object>();
const originalPrototypes = new WeakMap<object, object | null>();

interface MetaLike {
  __index?: ((t: object, k: PropertyKey) => unknown) | Record<PropertyKey, unknown>;
  __newindex?: ((t: object, k: PropertyKey, v: unknown) => void) | Record<PropertyKey, unknown>;
  __metatable?: object;
  [k: PropertyKey]: unknown;
}

function unwrap<T extends object>(t: T): T {
  const raw = (t as { [RAW_TARGET]?: T })[RAW_TARGET];
  return raw ?? t;
}

function makeProxy<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, key) {
      if (key === RAW_TARGET) return t;
      if (Reflect.has(t, key)) return Reflect.get(t, key);
      const mt = metatables.get(t) as MetaLike | undefined;
      if (!mt) return undefined;
      const __index = mt.__index;
      if (typeof __index === 'function') return __index(t, key);
      if (__index && typeof __index === 'object') {
        return (__index as Record<PropertyKey, unknown>)[key];
      }
      return undefined;
    },
    set(t, key, value) {
      const mt = metatables.get(t) as MetaLike | undefined;
      if (mt && !Reflect.has(t, key)) {
        const __newindex = mt.__newindex;
        if (typeof __newindex === 'function') {
          __newindex(t, key, value);
          return true;
        }
        if (__newindex && typeof __newindex === 'object') {
          (__newindex as Record<PropertyKey, unknown>)[key] = value;
          return true;
        }
      }
      return Reflect.set(t, key, value);
    },
    has(t, key) {
      if (Reflect.has(t, key)) return true;
      const mt = metatables.get(t) as MetaLike | undefined;
      if (!mt) return false;
      const __index = mt.__index;
      if (typeof __index === 'object' && __index !== null) {
        return key in __index;
      }
      return false;
    },
  });
}

export function setmetatable<T extends object>(t: T, mt: object | null): T {
  const raw = unwrap(t);
  if (!originalPrototypes.has(raw)) {
    originalPrototypes.set(raw, Object.getPrototypeOf(raw));
  }
  if (mt === null) {
    metatables.delete(raw);
    Object.setPrototypeOf(raw, originalPrototypes.get(raw) ?? Object.prototype);
    return raw;
  }
  metatables.set(raw, mt);
  Object.setPrototypeOf(raw, originalPrototypes.get(raw) ?? Object.prototype);
  const meta = mt as MetaLike;
  if (
    meta.__index
    && typeof meta.__index === 'object'
    && meta.__newindex === undefined
  ) {
    Object.setPrototypeOf(raw, meta.__index);
    return raw;
  }
  return makeProxy(raw);
}

export function getmetatable(t: object): object | null {
  const raw = unwrap(t);
  const mt = metatables.get(raw) as MetaLike | undefined;
  if (!mt) return null;
  if (mt.__metatable !== undefined) return mt.__metatable as object;
  return mt;
}

/** Get the metatable's metamethod for an operator (used by arith.ts). */
export function getMetamethod<K extends keyof MetaLike>(
  t: unknown,
  name: K,
): MetaLike[K] | undefined {
  if (t === null || t === undefined) return undefined;
  if (typeof t !== 'object' && typeof t !== 'function') return undefined;
  const raw = unwrap(t as object);
  const mt = metatables.get(raw) as MetaLike | undefined;
  return mt?.[name];
}

// ─── Raw access ─────────────────────────────────────────────────────────────

export function rawget<T extends object>(t: T, key: PropertyKey): unknown {
  const raw = unwrap(t);
  return Object.prototype.hasOwnProperty.call(raw, key)
    ? (raw as Record<PropertyKey, unknown>)[key]
    : undefined;
}

export function rawset<T extends object>(t: T, key: PropertyKey, value: unknown): T {
  const raw = unwrap(t);
  Object.defineProperty(raw, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
  return t;
}

export function rawequal(a: unknown, b: unknown): boolean {
  if (a !== null && typeof a === 'object') a = unwrap(a as object);
  if (b !== null && typeof b === 'object') b = unwrap(b as object);
  return Object.is(a, b);
}

export function rawlen(t: unknown): number {
  if (typeof t === 'string') return new TextEncoder().encode(t).length;
  if (t !== null && typeof t === 'object') {
    const raw = unwrap(t as object);
    if (Array.isArray(raw)) return raw.length;
  }
  return 0;
}
