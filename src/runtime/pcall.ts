/** Lua-style error object. `message` and optional `level` per Lua semantics. */
export class LuaError extends Error {
  level: number;
  constructor(message: string, level = 1) {
    super(message);
    this.name = 'LuaError';
    this.level = level;
  }
}

export function error(message: unknown, level = 1): never {
  if (message instanceof LuaError) throw message;
  throw new LuaError(typeof message === 'string' ? message : String(message), level);
}

export function assert<T>(condition: T, message: unknown = 'assertion failed!'): T {
  if (!condition || condition === false) {
    error(message);
  }
  return condition;
}

type PcallReturn<T> = [true, T] | [false, string];

export function pcall<T, A extends unknown[]>(
  fn: (...args: A) => T,
  ...args: A
): PcallReturn<T> | Promise<PcallReturn<T>> {
  let result: T;
  try {
    result = fn(...args);
  } catch (e) {
    return [false, errToString(e)];
  }
  if (result instanceof Promise) {
    return result.then(
      (value): PcallReturn<T> => [true, value],
      (e: unknown): PcallReturn<T> => [false, errToString(e)],
    );
  }
  return [true, result];
}

export function xpcall<T, A extends unknown[]>(
  fn: (...args: A) => T,
  handler: (msg: string) => string,
  ...args: A
): PcallReturn<T> | Promise<PcallReturn<T>> {
  let result: T;
  try {
    result = fn(...args);
  } catch (e) {
    return [false, handler(errToString(e))];
  }
  if (result instanceof Promise) {
    return result.then(
      (value): PcallReturn<T> => [true, value],
      (e: unknown): PcallReturn<T> => [false, handler(errToString(e))],
    );
  }
  return [true, result];
}

function errToString(e: unknown): string {
  if (e instanceof LuaError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
