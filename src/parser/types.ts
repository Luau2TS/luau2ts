// AST shapes emitted by wrapper.cpp. Tags match Luau's AstStat*/AstExpr*/AstType*/
// AstTypePack* class names, lowered to a discriminated union over `type`.
//
// Coverage parity with the wrapper: every Luau node kind emits a tagged shape
// here. Anything the wrapper genuinely cannot recognize surfaces as
// Unknown{Stat,Expr,Type,TypePack} with a numeric classIndex so callers can
// detect future Luau additions without crashing.
//
// Naming: an `AstStatLocal` (the `local x = 1` *statement*) becomes `LocalStat`;
// an `AstExprLocal` (the *expression* referencing a local) becomes `LocalExpr`;
// an `AstLocal` (the *binding info* for a local — name, isConst, annotation,
// location) becomes plain `Local`.

export interface Position {
  line: number;
  col: number;
}

export interface Loc {
  start: Position;
  end: Position;
}

interface NodeBase {
  type: string;
  loc: Loc;
}

// ─── Auxiliary structures ───────────────────────────────────────────────────

export interface Local {
  name: string;
  isConst: boolean;
  annotation: TypeNode | null;
  loc: Loc;
}

export type TypeOrPack =
  | { kind: 'type'; value: TypeNode }
  | { kind: 'typePack'; value: TypePack }
  | null;

export interface TypeList {
  types: TypeNode[];
  tailType: TypePack | null;
}

export interface ArgumentName {
  name: string;
  loc: Loc;
}

export type TableAccess = 'Read' | 'Write' | 'ReadWrite';

export interface TableProp {
  name: string;
  propType: TypeNode | null;
  access: TableAccess;
  accessLocation: Loc | null;
  loc: Loc;
}

export interface TableIndexer {
  indexType: TypeNode;
  resultType: TypeNode;
  access: TableAccess;
  accessLocation: Loc | null;
  loc: Loc;
}

export interface DeclaredExternProp {
  name: string;
  propType: TypeNode | null;
  isMethod: boolean;
  access: TableAccess;
  loc: Loc;
}

export type AttrType = 'Checked' | 'Native' | 'Deprecated' | 'DebugNoinline' | 'Unknown';

export interface Attr {
  type: 'Attr';
  attrType: AttrType;
  name: string;
  args: Expr[];
  loc: Loc;
}

export interface GenericType {
  type: 'GenericType';
  name: string;
  defaultValue: TypeNode | null;
  loc: Loc;
}

export interface GenericTypePack {
  type: 'GenericTypePack';
  name: string;
  defaultValue: TypePack | null;
  loc: Loc;
}

// ─── Operators ──────────────────────────────────────────────────────────────

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '//'
  | '%'
  | '^'
  | '..'
  | '~='
  | '=='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'and'
  | 'or';

export type UnaryOp = 'not' | '-' | '#';

export type NumberParseResult =
  | 'Ok'
  | 'Imprecise'
  | 'Malformed'
  | 'BinOverflow'
  | 'HexOverflow'
  | 'IntOverflow';

export type QuoteStyle = 'QuotedSimple' | 'QuotedSingle' | 'QuotedRaw' | 'Unquoted';

export type TableItemKind = 'List' | 'Record' | 'General';

export interface TableItem {
  kind: TableItemKind;
  key: Expr | null;
  value: Expr;
}

// ─── Statements ─────────────────────────────────────────────────────────────

export interface BlockStat extends NodeBase {
  type: 'Block';
  body: Stat[];
  hasEnd: boolean;
}

export interface IfStat extends NodeBase {
  type: 'If';
  condition: Expr;
  thenBody: Stat;
  elseBody: Stat | null;
}

export interface WhileStat extends NodeBase {
  type: 'While';
  condition: Expr;
  body: Stat;
  hasDo: boolean;
}

export interface RepeatStat extends NodeBase {
  type: 'Repeat';
  body: Stat;
  condition: Expr;
}

export interface BreakStat extends NodeBase {
  type: 'Break';
}

export interface ContinueStat extends NodeBase {
  type: 'Continue';
}

export interface ReturnStat extends NodeBase {
  type: 'Return';
  values: Expr[];
}

export interface ExprStat extends NodeBase {
  type: 'Expr';
  expr: Expr;
}

export interface LocalStat extends NodeBase {
  type: 'Local';
  vars: Local[];
  values: Expr[];
  isConst: boolean;
}

export interface ForStat extends NodeBase {
  type: 'For';
  var: Local;
  from: Expr;
  to: Expr;
  step: Expr | null;
  body: Stat;
}

export interface ForInStat extends NodeBase {
  type: 'ForIn';
  vars: Local[];
  values: Expr[];
  body: Stat;
}

export interface AssignStat extends NodeBase {
  type: 'Assign';
  vars: Expr[];
  values: Expr[];
}

export interface CompoundAssignStat extends NodeBase {
  type: 'CompoundAssign';
  op: BinaryOp;
  var: Expr;
  value: Expr;
}

export interface FunctionStat extends NodeBase {
  type: 'Function';
  name: Expr;
  func: FunctionExpr;
}

export interface LocalFunctionStat extends NodeBase {
  type: 'LocalFunction';
  name: Local;
  func: FunctionExpr;
  isConst: boolean;
}

export interface TypeAliasStat extends NodeBase {
  type: 'TypeAlias';
  name: string;
  generics: GenericType[];
  genericPacks: GenericTypePack[];
  aliasType: TypeNode;
  exported: boolean;
}

export interface TypeFunctionStat extends NodeBase {
  type: 'TypeFunction';
  name: string;
  body: FunctionExpr | null;
  exported: boolean;
  hasErrors: boolean;
}

export interface DeclareGlobalStat extends NodeBase {
  type: 'DeclareGlobal';
  name: string;
  declType: TypeNode;
}

export interface DeclareFunctionStat extends NodeBase {
  type: 'DeclareFunction';
  attributes: Attr[];
  name: string;
  generics: GenericType[];
  genericPacks: GenericTypePack[];
  params: TypeList;
  paramNames: ArgumentName[];
  vararg: boolean;
  retTypes: TypePack | null;
}

export interface DeclareExternTypeStat extends NodeBase {
  type: 'DeclareExternType';
  name: string;
  superName: string | null;
  props: DeclaredExternProp[];
  indexer: TableIndexer | null;
}

export interface StatErrorStat extends NodeBase {
  type: 'StatError';
  expressions: Expr[];
  statements: Stat[];
  messageIndex: number;
}

export interface UnknownStat extends NodeBase {
  type: 'UnknownStat';
  classIndex: number;
}

export type Stat =
  | BlockStat
  | IfStat
  | WhileStat
  | RepeatStat
  | BreakStat
  | ContinueStat
  | ReturnStat
  | ExprStat
  | LocalStat
  | ForStat
  | ForInStat
  | AssignStat
  | CompoundAssignStat
  | FunctionStat
  | LocalFunctionStat
  | TypeAliasStat
  | TypeFunctionStat
  | DeclareGlobalStat
  | DeclareFunctionStat
  | DeclareExternTypeStat
  | StatErrorStat
  | UnknownStat;

// ─── Expressions ────────────────────────────────────────────────────────────

export interface GroupExpr extends NodeBase {
  type: 'Group';
  expr: Expr;
}

export interface ConstantNilExpr extends NodeBase {
  type: 'ConstantNil';
}

export interface ConstantBoolExpr extends NodeBase {
  type: 'ConstantBool';
  value: boolean;
}

export interface ConstantNumberExpr extends NodeBase {
  type: 'ConstantNumber';
  value: number;
  parseResult: NumberParseResult;
}

export interface ConstantIntegerExpr extends NodeBase {
  type: 'ConstantInteger';
  value: number;
  parseResult: NumberParseResult;
}

export interface ConstantStringExpr extends NodeBase {
  type: 'ConstantString';
  value: string;
  quoteStyle: QuoteStyle;
}

export interface LocalExpr extends NodeBase {
  type: 'Local';
  name: string;
  upvalue: boolean;
}

export interface GlobalExpr extends NodeBase {
  type: 'Global';
  name: string;
}

export interface VarargsExpr extends NodeBase {
  type: 'Varargs';
}

export interface CallExpr extends NodeBase {
  type: 'Call';
  func: Expr;
  typeArguments: TypeOrPack[];
  args: Expr[];
  self: boolean;
  argLocation: Loc;
}

export interface IndexNameExpr extends NodeBase {
  type: 'IndexName';
  expr: Expr;
  index: string;
  op: '.' | ':';
}

export interface IndexExprExpr extends NodeBase {
  type: 'IndexExpr';
  expr: Expr;
  index: Expr;
}

export interface FunctionExpr extends NodeBase {
  type: 'Function';
  attributes: Attr[];
  generics: GenericType[];
  genericPacks: GenericTypePack[];
  self: Local | null;
  args: Local[];
  vararg: boolean;
  varargAnnotation: TypePack | null;
  returnAnnotation: TypePack | null;
  body: BlockStat;
  debugname: string;
}

export interface TableExpr extends NodeBase {
  type: 'Table';
  items: TableItem[];
}

export interface UnaryExpr extends NodeBase {
  type: 'Unary';
  op: UnaryOp;
  expr: Expr;
}

export interface BinaryExpr extends NodeBase {
  type: 'Binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface TypeAssertionExpr extends NodeBase {
  type: 'TypeAssertion';
  expr: Expr;
  annotation: TypeNode;
}

export interface IfElseExpr extends NodeBase {
  type: 'IfElse';
  condition: Expr;
  hasThen: boolean;
  trueExpr: Expr;
  hasElse: boolean;
  falseExpr: Expr;
}

export interface InterpStringExpr extends NodeBase {
  type: 'InterpString';
  strings: string[];
  expressions: Expr[];
}

export interface InstantiateExpr extends NodeBase {
  type: 'Instantiate';
  expr: Expr;
  typeArguments: TypeOrPack[];
}

export interface ExprErrorExpr extends NodeBase {
  type: 'ExprError';
  expressions: Expr[];
  messageIndex: number;
}

export interface UnknownExpr extends NodeBase {
  type: 'UnknownExpr';
  classIndex: number;
}

export type Expr =
  | GroupExpr
  | ConstantNilExpr
  | ConstantBoolExpr
  | ConstantNumberExpr
  | ConstantIntegerExpr
  | ConstantStringExpr
  | LocalExpr
  | GlobalExpr
  | VarargsExpr
  | CallExpr
  | IndexNameExpr
  | IndexExprExpr
  | FunctionExpr
  | TableExpr
  | UnaryExpr
  | BinaryExpr
  | TypeAssertionExpr
  | IfElseExpr
  | InterpStringExpr
  | InstantiateExpr
  | ExprErrorExpr
  | UnknownExpr;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TypeReferenceNode extends NodeBase {
  type: 'TypeReference';
  prefix: string | null;
  prefixLocation: Loc | null;
  name: string;
  hasParameterList: boolean;
  parameters: TypeOrPack[];
}

export interface TypeTableNode extends NodeBase {
  type: 'TypeTable';
  props: TableProp[];
  indexer: TableIndexer | null;
}

export interface TypeFunctionNode extends NodeBase {
  type: 'TypeFunction';
  attributes: Attr[];
  generics: GenericType[];
  genericPacks: GenericTypePack[];
  argTypes: TypeList;
  argNames: (ArgumentName | null)[];
  returnTypes: TypePack | null;
}

export interface TypeTypeofNode extends NodeBase {
  type: 'TypeTypeof';
  expr: Expr;
}

export interface TypeOptionalNode extends NodeBase {
  type: 'TypeOptional';
}

export interface TypeUnionNode extends NodeBase {
  type: 'TypeUnion';
  types: TypeNode[];
}

export interface TypeIntersectionNode extends NodeBase {
  type: 'TypeIntersection';
  types: TypeNode[];
}

export interface TypeErrorNode extends NodeBase {
  type: 'TypeError';
  types: TypeNode[];
  isMissing: boolean;
  messageIndex: number;
}

export interface TypeSingletonBoolNode extends NodeBase {
  type: 'TypeSingletonBool';
  value: boolean;
}

export interface TypeSingletonStringNode extends NodeBase {
  type: 'TypeSingletonString';
  value: string;
}

export interface TypeGroupNode extends NodeBase {
  type: 'TypeGroup';
  groupType: TypeNode;
}

export interface UnknownTypeNode extends NodeBase {
  type: 'UnknownType';
  classIndex: number;
}

export type TypeNode =
  | TypeReferenceNode
  | TypeTableNode
  | TypeFunctionNode
  | TypeTypeofNode
  | TypeOptionalNode
  | TypeUnionNode
  | TypeIntersectionNode
  | TypeErrorNode
  | TypeSingletonBoolNode
  | TypeSingletonStringNode
  | TypeGroupNode
  | UnknownTypeNode;

// ─── Type packs ─────────────────────────────────────────────────────────────

export interface TypePackExplicit extends NodeBase {
  type: 'TypePackExplicit';
  typeList: TypeList;
}

export interface TypePackVariadic extends NodeBase {
  type: 'TypePackVariadic';
  variadicType: TypeNode;
}

export interface TypePackGeneric extends NodeBase {
  type: 'TypePackGeneric';
  genericName: string;
}

export interface UnknownTypePack extends NodeBase {
  type: 'UnknownTypePack';
  classIndex: number;
}

export type TypePack = TypePackExplicit | TypePackVariadic | TypePackGeneric | UnknownTypePack;

// ─── Top level ──────────────────────────────────────────────────────────────

export interface ParseError {
  message: string;
  loc: Loc;
}

export interface HotComment {
  header: boolean;
  content: string;
  loc: Loc;
}

export type CommentKind = 'Comment' | 'BlockComment' | 'BrokenComment';

export interface Comment {
  kind: CommentKind;
  loc: Loc;
}

export interface ParseResult {
  errors: ParseError[];
  hotcomments: HotComment[];
  comments: Comment[];
  root: BlockStat | null;
  lines: number;
}
