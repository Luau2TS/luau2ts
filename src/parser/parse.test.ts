import { describe, expect, it } from 'vitest';
import { parse } from './index.js';
import type {
  AssignStat,
  Attr,
  BinaryExpr,
  BlockStat,
  CallExpr,
  CompoundAssignStat,
  ConstantBoolExpr,
  ConstantStringExpr,
  DeclareFunctionStat,
  DeclareGlobalStat,
  ExprStat,
  ForInStat,
  ForStat,
  FunctionExpr,
  FunctionStat,
  GlobalExpr,
  GroupExpr,
  IfElseExpr,
  IfStat,
  IndexExprExpr,
  IndexNameExpr,
  InterpStringExpr,
  LocalFunctionStat,
  LocalStat,
  RepeatStat,
  ReturnStat,
  Stat,
  TableExpr,
  TypeAliasStat,
  TypeAssertionExpr,
  TypeFunctionNode,
  TypeIntersectionNode,
  TypePackVariadic,
  TypeReferenceNode,
  TypeTableNode,
  TypeUnionNode,
  UnaryExpr,
  WhileStat,
} from './types.js';

const firstStat = (root: BlockStat | null): Stat => {
  expect(root).not.toBeNull();
  expect(root!.body.length).toBeGreaterThan(0);
  return root!.body[0]!;
};

describe('parse — top level', () => {
  it('returns errors / hotcomments / comments / root / lines', async () => {
    const r = await parse('-- hi\n--!strict\nlocal x = 1\n');
    expect(r.errors).toEqual([]);
    expect(r.lines).toBeGreaterThanOrEqual(2);
    expect(r.comments.length).toBeGreaterThanOrEqual(1);
    expect(r.hotcomments.length).toBe(1);
    expect(r.hotcomments[0]?.content).toContain('strict');
    expect(r.root?.type).toBe('Block');
  });

  it('reports a parse error with a location', async () => {
    const { errors } = await parse('local = ');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.loc.start.line).toBe(0);
    expect(typeof errors[0]?.message).toBe('string');
  });
});

describe('parse — statements', () => {
  it('parses local declarations with type annotations', async () => {
    const r = await parse('local x: number = 1\nlocal y, z = 2, "s"');
    const a = r.root!.body[0] as LocalStat;
    expect(a.type).toBe('Local');
    expect(a.vars[0]?.name).toBe('x');
    expect(a.vars[0]?.annotation?.type).toBe('TypeReference');
    expect(a.isConst).toBe(false);
    const b = r.root!.body[1] as LocalStat;
    expect(b.vars.map((v) => v.name)).toEqual(['y', 'z']);
    expect(b.values).toHaveLength(2);
  });

  it('parses if/elseif/else', async () => {
    const r = await parse('if a then b() elseif c then d() else e() end');
    const s = firstStat(r.root) as IfStat;
    expect(s.type).toBe('If');
    expect(s.elseBody?.type).toBe('If'); // elseif desugars to nested If
  });

  it('parses while + break + continue', async () => {
    const r = await parse('while x do break end\nwhile y do continue end');
    const w1 = r.root!.body[0] as WhileStat;
    expect(w1.type).toBe('While');
    const block1 = w1.body as BlockStat;
    expect(block1.body[0]?.type).toBe('Break');
    const w2 = r.root!.body[1] as WhileStat;
    const block2 = w2.body as BlockStat;
    expect(block2.body[0]?.type).toBe('Continue');
  });

  it('parses repeat/until', async () => {
    const r = await parse('repeat x() until done');
    const s = firstStat(r.root) as RepeatStat;
    expect(s.type).toBe('Repeat');
    expect(s.condition.type).toBe('Global');
  });

  it('parses numeric for with step', async () => {
    const r = await parse('for i = 1, 10, 2 do end');
    const f = firstStat(r.root) as ForStat;
    expect(f.type).toBe('For');
    expect(f.var.name).toBe('i');
    expect(f.step?.type).toMatch(/^Constant(Integer|Number)$/);
  });

  it('parses generic for', async () => {
    const r = await parse('for k, v in pairs(t) do end');
    const f = firstStat(r.root) as ForInStat;
    expect(f.type).toBe('ForIn');
    expect(f.vars.map((v) => v.name)).toEqual(['k', 'v']);
    expect(f.values[0]?.type).toBe('Call');
  });

  it('parses assignment + compound assignment', async () => {
    const r = await parse('a, b = 1, 2\na += 3');
    const assign = r.root!.body[0] as AssignStat;
    expect(assign.type).toBe('Assign');
    expect(assign.vars).toHaveLength(2);
    const compound = r.root!.body[1] as CompoundAssignStat;
    expect(compound.type).toBe('CompoundAssign');
    expect(compound.op).toBe('+');
  });

  it('parses function declarations (global, method, local)', async () => {
    const r = await parse(
      [
        'function foo(x) return x end',
        'function t:m(y) return y end',
        'local function bar() end',
      ].join('\n'),
    );
    const f1 = r.root!.body[0] as FunctionStat;
    expect(f1.type).toBe('Function');
    expect(f1.func.type).toBe('Function');
    const f2 = r.root!.body[1] as FunctionStat;
    expect(f2.type).toBe('Function');
    expect(f2.func.self).not.toBeNull();
    const f3 = r.root!.body[2] as LocalFunctionStat;
    expect(f3.type).toBe('LocalFunction');
    expect(f3.name.name).toBe('bar');
  });

  it('parses return with multiple values', async () => {
    const r = await parse('return 1, 2, "a"');
    const ret = firstStat(r.root) as ReturnStat;
    expect(ret.type).toBe('Return');
    expect(ret.values).toHaveLength(3);
  });

  it('parses type alias with generics', async () => {
    const r = await parse('type Box<T> = { value: T }');
    const a = firstStat(r.root) as TypeAliasStat;
    expect(a.type).toBe('TypeAlias');
    expect(a.name).toBe('Box');
    expect(a.generics).toHaveLength(1);
    expect(a.generics[0]?.name).toBe('T');
    expect(a.aliasType.type).toBe('TypeTable');
  });

  it('parses declare statements', async () => {
    const src = ['declare game: any', 'declare function require(p: string): any'].join('\n');
    const r = await parse(src);
    const g = r.root!.body[0] as DeclareGlobalStat;
    expect(g.type).toBe('DeclareGlobal');
    expect(g.name).toBe('game');
    const f = r.root!.body[1] as DeclareFunctionStat;
    expect(f.type).toBe('DeclareFunction');
    expect(f.name).toBe('require');
    expect(f.params.types).toHaveLength(1);
  });
});

describe('parse — expressions', () => {
  it('parses every literal kind', async () => {
    const r = await parse('return nil, true, 1, 1.5, "a", \'b\', [[c]]');
    const ret = firstStat(r.root) as ReturnStat;
    const types = ret.values.map((v) => v.type);
    expect(types[0]).toBe('ConstantNil');
    expect(types[1]).toBe('ConstantBool');
    // Luau parses `1` as ConstantNumber unless it requires integer semantics.
    expect(types[2]).toMatch(/^Constant(Integer|Number)$/);
    expect(types[3]).toBe('ConstantNumber');
    expect(types.slice(4)).toEqual(['ConstantString', 'ConstantString', 'ConstantString']);
    expect((ret.values[1] as ConstantBoolExpr).value).toBe(true);
    // Luau's AST collapses single- and double-quoted strings to QuotedSimple
    // unless storeCstData is on. Long-bracket strings stay as QuotedRaw.
    expect((ret.values[4] as ConstantStringExpr).quoteStyle).toBe('QuotedSimple');
    expect((ret.values[6] as ConstantStringExpr).quoteStyle).toBe('QuotedRaw');
  });

  it('parses parenthesized group, unary, binary', async () => {
    const r = await parse('return (-x) + #t * (a == b and 1 or 2)');
    const ret = firstStat(r.root) as ReturnStat;
    const expr = ret.values[0] as BinaryExpr;
    expect(expr.type).toBe('Binary');
    expect(expr.op).toBe('+');
    const left = expr.left as GroupExpr;
    expect(left.type).toBe('Group');
    expect((left.expr as UnaryExpr).op).toBe('-');
  });

  it('parses calls (regular, method, with type args)', async () => {
    const r = await parse(['foo(1, 2)', 't:method("x")', 'f<<number>>(1)'].join('\n'));
    const c1 = (r.root!.body[0] as ExprStat).expr as CallExpr;
    expect(c1.self).toBe(false);
    expect(c1.args).toHaveLength(2);
    const c2 = (r.root!.body[1] as ExprStat).expr as CallExpr;
    expect(c2.self).toBe(true);
    expect((c2.func as IndexNameExpr).op).toBe(':');
    const c3 = (r.root!.body[2] as ExprStat).expr as CallExpr;
    expect(c3.func.type).toBe('Instantiate');
  });

  it('parses dot and bracket indexing', async () => {
    const r = await parse('return t.a, t["b"]');
    const ret = firstStat(r.root) as ReturnStat;
    const a = ret.values[0] as IndexNameExpr;
    expect(a.type).toBe('IndexName');
    expect(a.op).toBe('.');
    expect(a.index).toBe('a');
    const b = ret.values[1] as IndexExprExpr;
    expect(b.type).toBe('IndexExpr');
    expect(b.index.type).toBe('ConstantString');
  });

  it('parses table literals (List, Record, General)', async () => {
    const r = await parse('return { 1, 2, foo = 3, [4] = 5 }');
    const ret = firstStat(r.root) as ReturnStat;
    const tbl = ret.values[0] as TableExpr;
    expect(tbl.type).toBe('Table');
    expect(tbl.items.map((i) => i.kind)).toEqual(['List', 'List', 'Record', 'General']);
  });

  it('parses anonymous function with vararg, return annotation, generics', async () => {
    const r = await parse('local f = function<T>(x: T, ...): (T, ...any) return x, ... end');
    const ls = firstStat(r.root) as LocalStat;
    const fn = ls.values[0] as FunctionExpr;
    expect(fn.type).toBe('Function');
    expect(fn.generics).toHaveLength(1);
    expect(fn.vararg).toBe(true);
    expect(fn.returnAnnotation?.type).toBe('TypePackExplicit');
  });

  it('parses type assertion `expr :: T`', async () => {
    const r = await parse('return x :: string');
    const ret = firstStat(r.root) as ReturnStat;
    const ta = ret.values[0] as TypeAssertionExpr;
    expect(ta.type).toBe('TypeAssertion');
    expect(ta.annotation.type).toBe('TypeReference');
  });

  it('parses if-then-else expression', async () => {
    const r = await parse('return if a then 1 elseif b then 2 else 3');
    const ret = firstStat(r.root) as ReturnStat;
    const ie = ret.values[0] as IfElseExpr;
    expect(ie.type).toBe('IfElse');
    expect(ie.hasThen).toBe(true);
    expect(ie.hasElse).toBe(true);
    expect((ie.falseExpr as IfElseExpr).type).toBe('IfElse'); // nested elseif
  });

  it('parses interpolated string', async () => {
    const r = await parse('return `hi {name}!`');
    const ret = firstStat(r.root) as ReturnStat;
    const i = ret.values[0] as InterpStringExpr;
    expect(i.type).toBe('InterpString');
    expect(i.strings).toEqual(['hi ', '!']);
    expect(i.expressions).toHaveLength(1);
    expect((i.expressions[0] as GlobalExpr).name).toBe('name');
  });
});

describe('parse — types and type packs', () => {
  it('parses qualified references with parameter list', async () => {
    const r = await parse('type X = mod.Inner<number, string>');
    const a = firstStat(r.root) as TypeAliasStat;
    const ref = a.aliasType as TypeReferenceNode;
    expect(ref.type).toBe('TypeReference');
    expect(ref.prefix).toBe('mod');
    expect(ref.name).toBe('Inner');
    expect(ref.parameters).toHaveLength(2);
  });

  it('parses table type with indexer + props', async () => {
    const r = await parse('type T = { x: number, [string]: any }');
    const a = firstStat(r.root) as TypeAliasStat;
    const tbl = a.aliasType as TypeTableNode;
    expect(tbl.type).toBe('TypeTable');
    expect(tbl.props).toHaveLength(1);
    expect(tbl.indexer).not.toBeNull();
  });

  it('parses function type', async () => {
    const r = await parse('type F = (a: number, ...string) -> (boolean, ...any)');
    const a = firstStat(r.root) as TypeAliasStat;
    const fn = a.aliasType as TypeFunctionNode;
    expect(fn.type).toBe('TypeFunction');
    expect(fn.argTypes.types).toHaveLength(1);
    expect(fn.argTypes.tailType?.type).toBe('TypePackVariadic');
    expect(fn.returnTypes?.type).toBe('TypePackExplicit');
  });

  it('parses union, intersection, optional', async () => {
    const r = await parse('type U = number | string\ntype I = A & B\ntype O = string?');
    const u = (r.root!.body[0] as TypeAliasStat).aliasType as TypeUnionNode;
    expect(u.type).toBe('TypeUnion');
    expect(u.types).toHaveLength(2);
    const i = (r.root!.body[1] as TypeAliasStat).aliasType as TypeIntersectionNode;
    expect(i.type).toBe('TypeIntersection');
    const o = (r.root!.body[2] as TypeAliasStat).aliasType as TypeUnionNode;
    expect(o.type).toBe('TypeUnion'); // `string?` desugars to `string | nil`
    expect(o.types.map((t) => t.type)).toContain('TypeOptional');
  });

  it('parses singleton types', async () => {
    const r = await parse('type S = "literal" | true');
    const a = firstStat(r.root) as TypeAliasStat;
    const u = a.aliasType as TypeUnionNode;
    expect(u.types[0]?.type).toBe('TypeSingletonString');
    expect(u.types[1]?.type).toBe('TypeSingletonBool');
  });

  it('parses typeof type', async () => {
    const r = await parse('type T = typeof(x)');
    const a = firstStat(r.root) as TypeAliasStat;
    expect(a.aliasType.type).toBe('TypeTypeof');
  });

  it('parses generic type pack via variadic', async () => {
    const r = await parse('type F = (...number) -> ()');
    const a = firstStat(r.root) as TypeAliasStat;
    const fn = a.aliasType as TypeFunctionNode;
    const tail = fn.argTypes.tailType as TypePackVariadic;
    expect(tail.type).toBe('TypePackVariadic');
    expect(tail.variadicType.type).toBe('TypeReference');
  });
});

describe('parse — attributes and source positions', () => {
  it('captures attributes on functions', async () => {
    const r = await parse('@native function fast() end');
    const f = firstStat(r.root) as FunctionStat;
    expect(f.func.attributes.length).toBeGreaterThan(0);
    const attr = f.func.attributes[0] as Attr;
    expect(attr.attrType).toBe('Native');
  });

  it('emits source positions on each statement', async () => {
    const r = await parse('local a = 1\nlocal b = 2\nlocal c = 3');
    expect(r.root!.body.map((s) => s.loc.start.line)).toEqual([0, 1, 2]);
  });
});
