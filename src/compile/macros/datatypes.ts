import ts from 'typescript';
import type { MacroArgs } from './index.js';
import { registerConstructorMacro, registerMacro } from './index.js';

const { factory } = ts;

// ─── `.new` constructors → `new TypeName(...)` ─────────────────────────────
// Constructors whose `.new(…)` signature is `(number, number, …)`. We
// cast each compiled arg `as unknown as number` so unknown-typed
// leaves from Phase-2 structural shapes (`frame.X.Scale`,
// `instance.Position.Magnitude`, …) flow through without TS2345.
const numericConstructorTypes = new Set<string>([
  'Vector3', 'Vector2', 'Vector3int16', 'Vector2int16',
  'UDim', 'UDim2',
  'NumberRange', 'NumberSequenceKeypoint',
  'Region3int16', 'Rect',
]);
const constructorTypes = [
  'Vector3', 'Vector2', 'Vector3int16', 'Vector2int16',
  'CFrame', 'Color3', 'BrickColor',
  'UDim', 'UDim2',
  'NumberRange', 'NumberSequence', 'NumberSequenceKeypoint',
  'ColorSequence', 'ColorSequenceKeypoint',
  'Region3', 'Region3int16', 'Rect', 'Ray',
  'RaycastParams', 'OverlapParams',
  'TweenInfo', 'Random', 'DateTime',
  'Faces', 'Axes', 'PhysicalProperties',
  'Path2DControlPoint', 'FloatCurveKey', 'RotationCurveKey',
  'CatalogSearchParams', 'Font',
] as const;
for (const t of constructorTypes) {
  registerConstructorMacro(`${t}.new`, t, 'rbxts', numericConstructorTypes.has(t));
}

// ─── Static factories → `TypeName.method(...)` ────────────────────────────

/** Static-factory `TypeName.method` calls whose signatures expect
 *  numeric args. We cast each compiled arg `as unknown as number`
 *  so unknown-typed leaves from Phase-2 structural shapes
 *  (a Local typed `{ X: unknown; ... }` reading `.X.Scale`, etc.)
 *  flow through without TS2345 at the call site. */
const NUMERIC_STATIC_FACTORIES = new Set([
  'UDim2.fromScale', 'UDim2.fromOffset',
  'Color3.fromRGB', 'Color3.fromHSV',
  'Vector3.FromAxis', 'Vector3.FromNormalId',
  'Vector2.FromAxis', 'Vector2.FromNormalId',
]);

function emitStaticCall(typeName: string, method: string): (a: MacroArgs) => ts.Expression {
  const key = `${typeName}.${method}`;
  const numeric = NUMERIC_STATIC_FACTORIES.has(key);
  return ({ ctx, compiledArgs }) => {
    ctx.useImport('@rbxts/types', typeName);
    const args = numeric
      ? compiledArgs.map((a) =>
          factory.createAsExpression(
            factory.createAsExpression(
              ts.isBinaryExpression(a) || ts.isConditionalExpression(a)
                ? factory.createParenthesizedExpression(a)
                : a,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
          ))
      : compiledArgs;
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier(typeName),
        factory.createIdentifier(method),
      ),
      undefined,
      args,
    );
  };
}

// CFrame static factories.
for (const m of [
  'Angles',
  'fromAxisAngle',
  'fromEulerAnglesXYZ',
  'fromEulerAnglesYXZ',
  'fromOrientation',
  'fromMatrix',
  'fromRotationBetweenVectors',
  'lookAt',
  'lookAlong',
  'identity',
]) registerMacro(`CFrame.${m}`, emitStaticCall('CFrame', m), 'rbxts');

// Color3.
for (const m of ['fromRGB', 'fromHSV', 'fromHex']) {
  registerMacro(`Color3.${m}`, emitStaticCall('Color3', m), 'rbxts');
}

// BrickColor.
for (const m of ['Random', 'palette', 'White', 'Gray', 'DarkGray', 'Black', 'Red', 'Yellow', 'Green', 'Blue']) {
  registerMacro(`BrickColor.${m}`, emitStaticCall('BrickColor', m), 'rbxts');
}

// UDim2.
for (const m of ['fromScale', 'fromOffset']) {
  registerMacro(`UDim2.${m}`, emitStaticCall('UDim2', m), 'rbxts');
}

// DateTime.
for (const m of ['now', 'fromIsoDate', 'fromUnixTimestamp', 'fromUnixTimestampMillis', 'fromUniversalTime', 'fromLocalTime']) {
  registerMacro(`DateTime.${m}`, emitStaticCall('DateTime', m), 'rbxts');
}

// Font.
for (const m of ['fromName', 'fromEnum', 'fromId']) {
  registerMacro(`Font.${m}`, emitStaticCall('Font', m), 'rbxts');
}

// Vector3 / Vector2 static factories (zero, one, axis vectors).
for (const t of ['Vector3', 'Vector2'] as const) {
  for (const m of ['zero', 'one', 'xAxis', 'yAxis', 'zAxis', 'FromAxis', 'FromNormalId']) {
    registerMacro(`${t}.${m}`, emitStaticCall(t, m), 'rbxts');
  }
}

// Region3 static factories.
for (const m of ['fromCFrame']) {
  registerMacro(`Region3.${m}`, emitStaticCall('Region3', m), 'rbxts');
}

// Path2DControlPoint static (rare).
for (const m of ['fromPosition']) {
  registerMacro(`Path2DControlPoint.${m}`, emitStaticCall('Path2DControlPoint', m), 'rbxts');
}
