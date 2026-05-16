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
//
// roblox-ts wires `new Instance("ClassName")` specially: the constructor
// takes a string literal and the result is typed as the corresponding
// subclass (Frame, Part, etc.). The subclass names themselves are
// declared as INTERFACES in @rbxts/types — not classes — so
// `new Part(...)` fires TS2693 ("only refers to a type"). Emit the
// `new Instance("X", parent?)` form so roblox-ts's class-resolver
// handles it AND the result inherits the proper subclass type.
//
// We DON'T cast the result to `any`. Subsequent runtime-children
// access (`wrap.Bar`, `frame.MyTextLabel`) will fail typecheck with
// strict-mode — that's intentional. Phase 2 of the rbxts cleanup
// will synthesize per-variable interfaces from the observed access
// pattern (`interface __Wrap extends Frame { Bar: __WrapBar }`) so
// the dynamic children resolve properly, and the emit becomes
// idiomatic rbxts without losing type info.
registerMacro(
  'Instance.new',
  ({ compiledArgs }) => {
    if (compiledArgs.length === 0) return undefined;
    return factory.createNewExpression(
      factory.createIdentifier('Instance'),
      undefined,
      compiledArgs,
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
  // Return the service reference at its declared type (e.g.
  // ReplicatedStorage / Players / TweenService). Subsequent
  // runtime-named-child access (`ReplicatedStorage.MyFolder`) WILL
  // fail typecheck — that's the surface area Phase 2 fixes by
  // synthesizing per-variable structural interfaces from observed
  // access patterns. Previously we cast to `any` here, which fired
  // roblox-ts's no-any rule on every access downstream.
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
