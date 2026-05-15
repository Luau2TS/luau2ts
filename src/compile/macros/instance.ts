import ts from 'typescript';
import { registerMacro } from './index.js';

const { factory } = ts;

// Roblox class names that are NOT valid TS identifiers (none today, but
// guard anyway). If the API dump ever surfaces a class with `-`, `.`, or
// reserved-word collision, we'll need to escape — for now, keep the lookup
// simple and assume identifiers.
function isValidIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// ─── Instance.new ─────────────────────────────────────────────────────────
registerMacro(
  'Instance.new',
  ({ ctx, call, compiledArgs }) => {
    // Need a literal-string first argument to resolve the class name.
    const first = call.args[0];
    if (!first || first.type !== 'ConstantString') return undefined;
    const className = (first as { value: string }).value;
    if (!isValidIdentifier(className)) return undefined;

    ctx.useImport('@rbxts/types', className);

    // Forward any remaining arguments (e.g. `Instance.new("Part", parent)`
    // becomes `new Part(parent)`).
    const ctorArgs = compiledArgs.slice(1);
    return factory.createNewExpression(
      factory.createIdentifier(className),
      undefined,
      ctorArgs,
    );
  },
  'rbxts',
);

// ─── game:GetService("X") ─ both colon and dot forms ──────────────────────
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

// roblox-ts also accepts `game:FindService("X")` for the same effect when
// the service may not be present. We map identically — the `@rbxts/services`
// import is always present in our shim, so FindService can never return nil.
registerMacro(
  'game.FindService',
  ({ ctx, call }) => gameGetService({ ctx, call }),
  'rbxts',
);

// ─── R.11 — Roact.* recognition ────────────────────────────────────────────
// `Roact.createElement(comp, props, children)` calls in Luau pass through
// to TS verbatim (they're just function calls). All we do here is auto-
// import `Roact` from `@rbxts/roact` so the call resolves at the call site.
// If the source already imports Roact some other way, the import is still
// safe — it just deduplicates with itself. Mount/unmount/Component/
// Fragment/Portal each fold through their own macros below.
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
