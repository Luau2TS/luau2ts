export interface SourceMapMapping {
  /** Line in the generated TS (0-indexed). */
  generatedLine: number;
  /** Column in the generated TS (0-indexed). */
  generatedColumn: number;
  /** Line in the original .luau (0-indexed). */
  originalLine: number;
  /** Column in the original .luau (0-indexed). */
  originalColumn: number;
}

export interface SourceMap {
  version: 3;
  file: string;
  sources: [string];
  sourcesContent: [string];
  names: [];
  mappings: string;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeVlqSigned(value: number): string {
  let v = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 0b11111;
    v >>>= 5;
    if (v > 0) digit |= 0b100000; // continuation bit
    out += BASE64_CHARS[digit];
  } while (v > 0);
  return out;
}

export function buildSourceMap(
  generatedFile: string,
  originalFile: string,
  originalContent: string,
  mappings: SourceMapMapping[],
): SourceMap {
  // Group by generated line.
  const lines = new Map<number, SourceMapMapping[]>();
  let maxLine = 0;
  for (const m of mappings) {
    if (m.generatedLine > maxLine) maxLine = m.generatedLine;
    let bucket = lines.get(m.generatedLine);
    if (!bucket) {
      bucket = [];
      lines.set(m.generatedLine, bucket);
    }
    bucket.push(m);
  }

  // VLQ encoding state — last absolute values across mappings.
  let prevGenCol = 0;
  let prevOrigLine = 0;
  let prevOrigCol = 0;

  const out: string[] = [];
  for (let line = 0; line <= maxLine; line++) {
    if (line > 0) prevGenCol = 0; // reset gen column at each line
    const bucket = (lines.get(line) ?? []).sort((a, b) => a.generatedColumn - b.generatedColumn);
    const segments: string[] = [];
    for (const m of bucket) {
      let s = '';
      s += encodeVlqSigned(m.generatedColumn - prevGenCol);
      s += encodeVlqSigned(0); // source index — only one source
      s += encodeVlqSigned(m.originalLine - prevOrigLine);
      s += encodeVlqSigned(m.originalColumn - prevOrigCol);
      segments.push(s);
      prevGenCol = m.generatedColumn;
      prevOrigLine = m.originalLine;
      prevOrigCol = m.originalColumn;
    }
    out.push(segments.join(','));
  }

  return {
    version: 3,
    file: generatedFile,
    sources: [originalFile],
    sourcesContent: [originalContent],
    names: [],
    mappings: out.join(';'),
  };
}

/** Encode a sourcemap as a base64 data URL suitable for appending to TS output.
 *  Returns a string of the form `// # source` + `MappingURL=data:...` so the
 *  sourcemap directive is consumed by JS tooling but ignored when this file
 *  is itself loaded as TypeScript. */
export function inlineSourceMapURL(map: SourceMap): string {
  const json = JSON.stringify(map);
  const base64 =
    typeof Buffer !== 'undefined'
      ? Buffer.from(json, 'utf8').toString('base64')
      : btoa(unescape(encodeURIComponent(json)));
  return `//# sourceMappingURL=data:application/json;base64,${base64}\n`;
}
