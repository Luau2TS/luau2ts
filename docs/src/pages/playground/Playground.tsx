import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import styles from './Playground.module.css';
import { bootstrapWorkerTypings } from './_typings';

const DEFAULT_LUAU = `local Workspace = game:GetService("Workspace")
local Players = game:GetService("Players")

local Animal = setmetatable({}, {})
Animal.__index = Animal

function Animal.new(name)
    local self = setmetatable({}, Animal)
    self:constructor(name)
    return self
end

function Animal:constructor(name)
    self.name = name
    self.health = 100
end

function Animal:greet()
    return "Hello, " .. self.name
end

local function spawnPart(position: Vector3)
    local part = Instance.new("Part")
    part.Position = position + Vector3.new(0, 5, 0)
    part.Size = Vector3.new(2, 2, 2)
    part.Color = Color3.fromRGB(255, 100, 100)
    part.Parent = Workspace
    return part
end

local animals = {}
for i = 1, 3 do
    table.insert(animals, Animal.new("animal" .. tostring(i)))
end

for _, a in ipairs(animals) do
    print(a:greet())
end
`;

const DEFAULT_TS = `class Animal {
    health = 100;
    constructor(public name: string) {}
    greet(): string {
        return \`Hello, \${this.name}\`;
    }
}

const animals: Animal[] = [];
for (let i = 1; i <= 3; i++) {
    animals.push(new Animal(\`animal\${i}\`));
}

for (const a of animals) {
    print(a.greet());
}
`;

type CompatMode = 'native' | 'rbxts';
type Direction = 'luauToTs' | 'tsToLuau';

interface CompileShape {
  source: string;
  errors: { message: string; loc?: { start: { line: number; col: number } } }[];
}

interface CompilerModule {
  compile: (source: string, options?: { compatMode?: CompatMode }) => Promise<CompileShape>;
}

export default function Playground(): ReactNode {
  const colorMode = useColorModeFromDom();
  // Two independent buffers so a swap doesn't lose the user's work in
  // either pane. The active direction picks which one is editable / which
  // gets compiled into.
  const [luauSource, setLuauSource] = useState<string>(DEFAULT_LUAU);
  const [tsSource, setTsSource] = useState<string>(DEFAULT_TS);
  const [mode, setMode] = useState<CompatMode>('rbxts');
  const [direction, setDirection] = useState<Direction>('luauToTs');
  const [output, setOutput] = useState<string>('');
  const [errors, setErrors] = useState<CompileShape['errors']>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const [workerStatus, setWorkerStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const compilerRef = useRef<CompilerModule | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lazy-load our Luau→TS compiler on first paint.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = (await import('luau2ts')) as unknown as CompilerModule;
        if (!cancelled) compilerRef.current = mod;
        if (!cancelled && direction === 'luauToTs') runCompile();
      } catch (e) {
        if (!cancelled) {
          setErrors([{ message: `Failed to load Luau→TS compiler: ${(e as Error).message}` }]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Lazy-spawn the rbxts worker the first time the user flips. The worker
  // bundle is ~4 MB, so we don't load it unless someone actually needs it.
  // After spawn, fetch @rbxts/types + @rbxts/compiler-types from jsdelivr
  // into the worker's virtual FS so roblox-ts has the typings it expects;
  // the MacroManager fails on any source if Promise / Map / etc. aren't
  // declared.
  useEffect(() => {
    if (direction !== 'tsToLuau') return;
    if (workerRef.current && workerStatus === 'ready') {
      runCompile();
      return;
    }
    if (workerStatus === 'loading') return;
    setWorkerStatus('loading');
    let cancelled = false;
    (async () => {
      try {
        const w = new Worker('/rbxts-worker.js');
        w.addEventListener('message', (e: MessageEvent<{ type: string; ok: boolean; source: string }>) => {
          if (e.data?.type === 'compiled') {
            setOutput(e.data.source);
            setErrors(e.data.ok ? [] : [{ message: 'roblox-ts compile errors (see output)' }]);
            setBusy(false);
          }
        });
        w.addEventListener('error', (e) => {
          setErrors([{ message: `Worker error: ${e.message ?? 'unknown'}` }]);
          setWorkerStatus('error');
          setBusy(false);
        });
        workerRef.current = w;
        await bootstrapWorkerTypings(w);
        if (cancelled) return;
        setWorkerStatus('ready');
        runCompile();
      } catch (e) {
        if (!cancelled) {
          setErrors([{ message: `Failed to spawn TS→Luau worker: ${(e as Error).message}` }]);
          setWorkerStatus('error');
        }
      }
    })();
    return () => {
      cancelled = true;
      // Keep the worker alive across direction flips so we don't pay the
      // 4 MB load cost twice. Only tear down on unmount.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction]);

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  // Recompile on source / mode / direction change with a 150ms debounce.
  // Also retriggers when the worker transitions to 'ready' so the first
  // compile after typings finish loading actually fires.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runCompile();
    }, 150);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [luauSource, tsSource, mode, direction, workerStatus]);

  async function runCompile(): Promise<void> {
    if (direction === 'luauToTs') {
      const c = compilerRef.current;
      if (!c) return;
      setBusy(true);
      try {
        const r = await c.compile(luauSource, { compatMode: mode });
        setOutput(r.source);
        setErrors(r.errors ?? []);
      } catch (e) {
        setErrors([{ message: (e as Error).message }]);
        setOutput('');
      } finally {
        setBusy(false);
      }
    } else {
      const w = workerRef.current;
      if (!w || workerStatus !== 'ready') return;
      setBusy(true);
      w.postMessage({ type: 'compile', source: tsSource });
    }
  }

  const prismTheme = colorMode === 'dark' ? themes.dracula : themes.github;
  const flipped = direction === 'tsToLuau';
  const sourceValue = flipped ? tsSource : luauSource;
  const setSourceValue = flipped ? setTsSource : setLuauSource;
  const sourceLabel = flipped ? 'TypeScript source' : 'Luau source';
  const outputLabel = flipped ? 'Luau output' : 'TypeScript output';
  const sourceLang = flipped ? 'tsx' : 'lua';
  const outputLang = flipped ? 'lua' : 'tsx';

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <h1 className={styles.title}>
          {flipped ? 'TypeScript → Luau' : 'Luau → TypeScript'} playground
        </h1>
        <div className={styles.controls}>
          {!flipped && (
            <label className={styles.modeLabel}>
              <span>Compat mode:</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as CompatMode)}
                className={styles.select}
              >
                <option value="native">native (luau2ts/runtime)</option>
                <option value="rbxts">rbxts (@rbxts/* shim)</option>
              </select>
            </label>
          )}
          <span className={styles.busy}>
            {flipped && workerStatus === 'loading'
              ? 'loading roblox-ts + @rbxts/types…'
              : busy
                ? 'compiling…'
                : ''}
          </span>
        </div>
      </div>

      <div className={styles.panes}>
        {/* Source pane is always on the left, output pane always on the
            right. Flipping the direction swaps which one is editable and
            which language each one carries — not their physical position. */}
        <SourcePane
          source={sourceValue}
          label={sourceLabel}
          lang={sourceLang}
          onChange={setSourceValue}
          prismTheme={prismTheme}
        />

        <button
          type="button"
          onClick={() =>
            setDirection((d) => (d === 'luauToTs' ? 'tsToLuau' : 'luauToTs'))
          }
          className={styles.swap}
          aria-label="Swap direction"
          title={
            flipped
              ? 'Switch to Luau → TypeScript'
              : 'Switch to TypeScript → Luau (loads roblox-ts in a worker)'
          }
        >
          <SwapIcon />
        </button>

        <OutputPane
          output={output}
          label={outputLabel}
          lang={outputLang}
          errors={errors}
          prismTheme={prismTheme}
        />
      </div>
    </div>
  );
}

function SourcePane({
  source,
  label,
  lang,
  onChange,
  prismTheme,
}: {
  source: string;
  label: string;
  lang: string;
  onChange: (v: string) => void;
  prismTheme: import('prism-react-renderer').PrismTheme;
}): ReactNode {
  // Line-number gutter: count newlines, render a fixed-width column to
  // the left of the textarea, scroll-sync via an onScroll handler. The
  // column's `overflow: hidden` plus a manually-set scrollTop mirrors the
  // textarea's vertical scroll so multi-page sources stay aligned.
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const lineCount = useMemo(() => Math.max(1, source.split('\n').length), [source]);

  function syncScroll(): void {
    if (gutterRef.current && taRef.current) {
      gutterRef.current.scrollTop = taRef.current.scrollTop;
    }
  }

  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>{label}</div>
      <div className={styles.editorWrap}>
        <div className={styles.editorGutter} ref={gutterRef} aria-hidden>
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className={styles.editorGutterLine}>{i + 1}</div>
          ))}
        </div>
        <textarea
          ref={taRef}
          value={source}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          spellCheck={false}
          className={styles.editor}
          aria-label={label}
        />
      </div>
      {/* Keep `lang` and `prismTheme` referenced so the editor pane can
          later swap to a syntax-highlighted contenteditable surface
          without changing the prop signature. */}
      <span style={{ display: 'none' }}>{lang}{prismTheme.plain?.color ?? ''}</span>
    </div>
  );
}

function OutputPane({
  output,
  label,
  lang,
  errors,
  prismTheme,
}: {
  output: string;
  label: string;
  lang: string;
  errors: CompileShape['errors'];
  prismTheme: import('prism-react-renderer').PrismTheme;
}): ReactNode {
  return (
    <div className={styles.pane}>
      <div className={styles.paneHeader}>{label}</div>
      <Output source={output} lang={lang} prismTheme={prismTheme} />
      {errors.length > 0 && (
        <div className={styles.errors}>
          {errors.map((e, i) => (
            <div key={i} className={styles.errorRow}>
              {e.loc ? `line ${e.loc.start.line + 1}: ` : ''}
              {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function useColorModeFromDom(): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const html = document.documentElement;
    const read = (): void => {
      setMode(html.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    };
    read();
    const obs = new MutationObserver(read);
    obs.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return mode;
}

function SwapIcon(): ReactNode {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M7 16V4M7 4L3 8M7 4l4 4" />
      <path d="M17 8v12M17 20l-4-4M17 20l4-4" />
    </svg>
  );
}

function Output({
  source,
  lang,
  prismTheme,
}: {
  source: string;
  lang: string;
  prismTheme: import('prism-react-renderer').PrismTheme;
}): ReactNode {
  // Show the compiler's `// Compiled by …` header verbatim. Earlier we
  // stripped it for compactness, but it's a useful tell for which compiler
  // produced the output (ours vs. roblox-ts) and for what version.
  return (
    <Highlight code={source} language={lang} theme={prismTheme}>
      {({ className, style, tokens, getLineProps, getTokenProps }) => (
        <pre className={`${className} ${styles.output}`} style={style}>
          {tokens.map((line, i) => (
            <div key={i} {...getLineProps({ line })}>
              <span className={styles.lineNum}>{i + 1}</span>
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}
