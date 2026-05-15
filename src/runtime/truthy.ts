export type LuaFalsy = false | null | undefined;
export type LuaTruthy<T> = Exclude<T, LuaFalsy>;

export function isTruthy<T>(value: T): value is LuaTruthy<T> {
  return (
    value !== false
    && value !== null
    && value !== undefined
    && !(
      typeof value === 'object'
      && value !== null
      && (value as { __isNull?: boolean }).__isNull === true
    )
  );
}

export function luaNot<T>(value: T): value is Extract<T, LuaFalsy> {
  return !isTruthy(value);
}

/**
 * `a and b` in Lua: returns the first falsy value, otherwise the last value.
 * Note both operands are passed already-evaluated; this helper does NOT
 * short-circuit (the compiler emits its own short-circuit when it can).
 */
export function luaAnd<A, B>(a: A, b: B): A | B {
  return isTruthy(a) ? b : a;
}

/**
 * `a or b` in Lua: returns the first truthy value, otherwise the last.
 */
export function luaOr<A, B>(a: A, b: B): A | B {
  return isTruthy(a) ? a : b;
}
