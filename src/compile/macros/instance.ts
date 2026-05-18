import ts from 'typescript';
import { registerMacro } from './index.js';

const { factory } = ts;

function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// ─── Instance.new ─────────────────────────────────────────────────────────
// Emit `new Instance("ClassName", parent?)` so roblox-ts's class-resolver
// produces the proper subclass type (Frame, Part, …).
registerMacro(
  'Instance.new',
  ({ ctx, call, compiledArgs }) => {
    if (compiledArgs.length === 0) return undefined;
    const firstArg = call.args[0];
    const literalClassName = firstArg && firstArg.type === 'ConstantString';
    // Non-literal class names need a cast — Instance's ctor wants `keyof CreatableInstances`.
    const args = literalClassName
      ? compiledArgs
      : [
          factory.createAsExpression(
            factory.createAsExpression(
              compiledArgs[0]!,
              factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            ),
            factory.createTypeReferenceNode('keyof CreatableInstances', undefined),
          ),
          ...compiledArgs.slice(1),
        ];
    if (args[1] && !ts.isSpreadElement(args[1])) {
      // Skip the redundant cast when the Luau-side arg is already an
      // Instance subclass (service, typed-class local, etc.).
      const parentLuau = call.args[1];
      const skipParentCast =
        parentLuau
        && (
          (parentLuau.type === 'Global' && ctx.oracle.isService(parentLuau.name))
          || (parentLuau.type === 'Local'
              && !!ctx.tsTypedClassLocal.get(parentLuau.name)
              && ctx.oracle.isA(ctx.tsTypedClassLocal.get(parentLuau.name)!, 'Instance'))
        );
      if (!skipParentCast) {
        args[1] = factory.createAsExpression(
          factory.createAsExpression(
            args[1],
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ),
          factory.createTypeReferenceNode('Instance', undefined),
        );
      }
    }
    return factory.createNewExpression(
      factory.createIdentifier('Instance'),
      undefined,
      args,
    );
  },
  'rbxts',
);

// ─── game:GetService("X") ─────────────────────────────────────────────────
function gameGetService({
  ctx,
  call,
}: {
  ctx: import('../context.js').CompileContext;
  call: import('../../parser/index.js').Expr & { type: 'Call' };
}): ts.Expression | undefined {
  const first = call.args[0];
  if (!first || first.type !== 'ConstantString') return undefined;
  const serviceName = (first as { value: string }).value;
  if (!isValidIdentifier(serviceName)) return undefined;

  ctx.useImport('@rbxts/services', serviceName);
  return factory.createIdentifier(serviceName);
}

registerMacro(
  'game.GetService',
  ({ ctx, call }) => gameGetService({ ctx, call }),
  'rbxts',
);

registerMacro(
  'game.FindService',
  ({ ctx, call }) => gameGetService({ ctx, call }),
  'rbxts',
);

// ─── Roact.* ──────────────────────────────────────────────────────────────
function autoImportRoact(member: string) {
  return ({ ctx, compiledArgs }: import('./index.js').MacroArgs) => {
    ctx.useImport('@rbxts/roact', 'Roact');
    return factory.createCallExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('Roact'),
        factory.createIdentifier(member),
      ),
      undefined,
      compiledArgs,
    );
  };
}

for (const m of ['createElement', 'mount', 'unmount', 'update']) {
  registerMacro(`Roact.${m}`, autoImportRoact(m), 'rbxts');
}
