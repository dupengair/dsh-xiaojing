/**
 * JSONC 定点改写：只替换顶层某一个键的值，其余字节（含注释、缩进、键顺序）原样保留。
 *
 * 为什么不用「读成对象再整份 stringify」：那样会把用户手写的 `//` 注释和排版全部抹掉
 * （见 session-binding.ts 的旧实现）。这里用一个小扫描器定位该键值的字符区间，做一次
 * 区间替换；改完再解析一遍校验，校验不过就抛错、绝不写盘。
 *
 * 必须始终成立：只在「顶层对象的一个成员」这一粒度动刀；不做格式化、不重排、不删注释。
 * @module dsh-pet/src/host/config/jsonc-edit
 */
import { stripJsonc } from './jsonc.ts';

/** 扫描时跳过空白与注释。 */
function skipTrivia(src: string, from: number): number {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\r' && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('Unterminated JSONC block comment');
      i = end + 2;
      continue;
    }
    break;
  }
  return i;
}

/** 从 `from` 起读一个 JSON 字符串，返回结束位置（不含）与解码后的值。 */
function readString(src: string, from: number): { end: number; value: string } {
  let i = from + 1;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') return { end: i + 1, value: JSON.parse('"' + out + '"') as string };
    out += ch;
    i++;
  }
  throw new SyntaxError('Unterminated string in JSONC');
}

/** 从值起点扫到值结束（不含），跳过字符串内的花括号与注释。 */
function scanValueEnd(src: string, from: number): number {
  const ch = src[from];
  if (ch === '"') return readString(src, from).end;
  if (ch !== '{' && ch !== '[') {
    // 标量：读到分隔符或收尾为止
    let i = from;
    while (i < src.length && !',}] \t\r\n'.includes(src[i] as string)) i++;
    return i;
  }
  let depth = 0;
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      i = readString(src, i).end;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\r' && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new SyntaxError('Unterminated JSONC block comment');
      i = end + 2;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  throw new SyntaxError('Unterminated value in JSONC');
}

/** 某位置所在行行首的缩进（只含空白）。 */
function lineIndent(src: string, pos: number): string {
  let i = pos;
  while (i > 0 && src[i - 1] !== '\n') i--;
  const m = /^[ \t]*/u.exec(src.slice(i, pos));
  return m ? m[0] : '';
}

/**
 * 把 `JSON.stringify(value, null, 2)` 产出的文本重排成文件自己的缩进风格。
 *
 * JSON.stringify 的续行是 `2 × 层级` 个空格（相对行首），而这次插入的键处在某一行的缩进
 * 之下，所以要按「行首缩进 + 每级缩进单位 × 层级」重算。
 */
function reindent(text: string, lineBase: string, unit: string): string {
  return text
    .split('\n')
    .map((line, index) => {
      if (index === 0) return line;
      const lead = /^ */u.exec(line)?.[0].length ?? 0;
      return lineBase + unit.repeat(Math.floor(lead / 2)) + line.slice(lead);
    })
    .join('\n');
}

interface Member {
  key: string;
  /** 值的起止（不含两端空白） */
  valueStart: number;
  valueEnd: number;
}

/** 解析顶层对象的成员位置表；结构可疑就抛错。 */
function scanRoot(src: string): { open: number; close: number; members: Member[] } {
  const open = skipTrivia(src, 0);
  if (src[open] !== '{') throw new SyntaxError('root of user config is not an object');
  const members: Member[] = [];
  let i = skipTrivia(src, open + 1);
  while (i < src.length) {
    if (src[i] === '}') return { open, close: i, members };
    if (src[i] === ',') {
      i = skipTrivia(src, i + 1);
      continue;
    }
    if (src[i] !== '"') throw new SyntaxError('expected member name in root object');
    const name = readString(src, i);
    i = skipTrivia(src, name.end);
    if (src[i] !== ':') throw new SyntaxError('expected colon after member name');
    const valueStart = skipTrivia(src, i + 1);
    const valueEnd = scanValueEnd(src, valueStart);
    members.push({ key: name.value, valueStart, valueEnd });
    i = skipTrivia(src, valueEnd);
  }
  throw new SyntaxError('root object is not closed');
}

/** 键顺序无关的规范化（用于校验改写结果是否语义一致）。 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * 把顶层键 `key` 的值改成 `value`，保留文件其余内容（注释、缩进、键顺序）。
 *
 * 键已存在 → 只替换它那一段值；键不存在 → 在根对象末尾追加一个成员。
 * 写完先做一致性校验（解析结果必须等于「旧对象 + 新键」），不通过就抛错、不返回。
 *
 * @param src - 原始 JSONC 文本
 * @param key - 顶层键名
 * @param value - 新的值（JSON 可序列化）
 * @returns 改写后的文本
 */
export function setJsoncTopLevelValue(src: string, key: string, value: unknown): string {
  const { open, close, members } = scanRoot(src);
  const encoded = JSON.stringify(value, null, 2);
  const rootIndent = lineIndent(src, open);
  // 每级缩进单位：从第一个成员的缩进反推（多数是 2，有人喜欢 4 也照他的来）
  const first = members[0];
  const unit = first === undefined ? '  ' : lineIndent(src, first.valueStart).slice(rootIndent.length) || '  ';
  const memberIndent = rootIndent + unit;

  let next: string;
  const hit = members.find((m) => m.key === key);
  if (hit) {
    const base = lineIndent(src, hit.valueStart);
    next = src.slice(0, hit.valueStart) + reindent(encoded, base, unit) + src.slice(hit.valueEnd);
  } else {
    // 追加：找到根对象「收尾前最后一段空白」的起点，用它作为插入区间
    let tail = close;
    while (tail > open + 1 && ' \t\r\n'.includes(src[tail - 1] as string)) tail--;
    const lastChar = src[tail - 1];
    const needsComma = tail > open + 1 && lastChar !== ',';
    const body =
      (needsComma ? ',' : '') +
      '\n' +
      memberIndent +
      JSON.stringify(key) +
      ': ' +
      reindent(encoded, memberIndent, unit) +
      '\n' +
      rootIndent;
    next = src.slice(0, tail) + body + src.slice(close);
  }

  const before = JSON.parse(stripJsonc(src)) as Record<string, unknown>;
  const after = JSON.parse(stripJsonc(next)) as Record<string, unknown>;
  const expected = { ...before, [key]: value };
  if (JSON.stringify(canonical(after)) !== JSON.stringify(canonical(expected))) {
    throw new SyntaxError(`JSONC edit for "${key}" did not round-trip; refusing to write`);
  }
  return next;
}
