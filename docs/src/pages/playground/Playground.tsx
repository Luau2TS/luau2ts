import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import styles from './Playground.module.css';

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

type CompatMode = 'native' | 'rbxts';

interface CompileError {
  message: string;
  loc?: { start: { line: number; col: number } };
}

interface CompileShape {
  source: string;
  errors: CompileError[];
}

interface CompilerModule {
  compile: (source: string, options?: { compatMode?: CompatMode }) => Promise<CompileShape>;
}

function useColorMode(): 'light' | 'dark' {
  const [mode, setMode] = useState<'light' | 'dark'>(() => {
    if (typeof document === 'undefined') return 'light';
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  });
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const obs = new MutationObserver(() => {
      setMode(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return mode;
}

export default function Playground(): ReactNode {
  const colorMode = useColorMode();
  const [luauSource, setLuauSource] = useState<string>(DEFAULT_LUAU);
  const [mode, setMode] = useState<CompatMode>('rbxts');
  const [output, setOutput] = useState<string>('');
  const [errors, setErrors] = useState<CompileError[]>([]);
  const [busy, setBusy] = useState<boolean>(false);
  const compilerRef = useRef<CompilerModule | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = (await import('luau2ts')) as unknown as CompilerModule;
        if (!cancelled) {
          compilerRef.current = mod;
          runCompile(luauSource, mode);
        }
      } catch (e) {
        if (!cancelled) {
          setErrors([{ message: `Failed to load compiler: ${(e as Error).message}` }]);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runCompile(src: string, m: CompatMode): Promise<void> {
    const compiler = compilerRef.current;
    if (!compiler) return;
    setBusy(true);
    try {
      const r = await compiler.compile(src, { compatMode: m });
      setOutput(r.source);
      setErrors(r.errors ?? []);
    } catch (e) {
      setErrors([{ message: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }

  // Debounced recompile on input or mode change.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runCompile(luauSource, mode), 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [luauSource, mode]);

  const theme = colorMode === 'dark' ? themes.dracula : themes.github;

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.title}>Luau → TypeScript</span>
        <label className={styles.modeLabel}>
          Mode:
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as CompatMode)}
            className={styles.select}
          >
            <option value="rbxts">rbxts (roblox-ts compatible)</option>
            <option value="native">native (luau2ts/runtime)</option>
          </select>
        </label>
        <span className={styles.busy}>{busy ? 'compiling…' : ' '}</span>
      </div>

      <div className={styles.panes}>
        <div className={styles.pane}>
          <div className={styles.paneHeader}>Luau</div>
          <textarea
            value={luauSource}
            onChange={(e) => setLuauSource(e.target.value)}
            className={styles.editor}
            spellCheck={false}
          />
        </div>

        <div className={styles.pane}>
          <div className={styles.paneHeader}>TypeScript</div>
          <div className={styles.output}>
            <Highlight code={output} language="typescript" theme={theme}>
              {({ className, style, tokens, getLineProps, getTokenProps }) => (
                <pre className={className} style={style}>
                  {tokens.map((line, i) => (
                    <div key={i} {...getLineProps({ line })}>
                      {line.map((token, j) => (
                        <span key={j} {...getTokenProps({ token })} />
                      ))}
                    </div>
                  ))}
                </pre>
              )}
            </Highlight>
          </div>
        </div>
      </div>

      {errors.length > 0 && (
        <div className={styles.errors}>
          {errors.map((err, i) => (
            <div key={i} className={styles.errorRow}>
              {err.loc && `line ${err.loc.start.line}:${err.loc.start.col}: `}
              {err.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
