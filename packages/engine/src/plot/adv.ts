/**
 * 手写剧本 .adv 的解析：文本 → Script IR（docs/ARCHITECTURE.md 5.4）。纯函数，界面也可以直接用。
 *
 *   # 注释
 *   bg library_evening fade
 *   bgm calm_daily                 bgm stop 停止音乐
 *   show lin neutral left          hide lin
 *   lin "……你也来找那本书？"         说话（say lin "…" 也行）
 *   narrate "夕阳把书架的影子拉得很长。" 旁白（只写一个带引号的字符串也行）
 *   think "要不要告诉她？"            内心独白（think lin "…" 是别人的）
 *   sfx / voice / cg / video <素材 id>、effect <效果名>、wait <秒>
 *   set affinity.char_lin +5       +N / -N / =值 / 值；布尔和字符串直接写 true、"文字"
 *   point sc_01_1                  演到了这一幕的要点
 *   jump sc_02                     走这一幕的出口
 *   choice                         选项；每个选项一行，后面缩进的是选完之后的内容
 *     "我是来找你的" -> set affinity.char_lin +5
 *     "撬开锁" check attr.wit dc 12
 *       if {"check": "pass"}
 *         narrate "锁开了。"
 *       else
 *         narrate "锁纹丝不动。"
 *     "离开" if {"flag": "flags.has_key"} -> goto sc_03
 *
 * 条件只能写 JSON 结构（16.3），不支持字符串表达式。
 */
import {
  type CheckSpec,
  type ChoiceOption,
  Condition,
  type Scalar,
  type ScriptCommand,
  VarEffect,
} from '@auto-adv/schema';

export interface AdvSyntaxIssue {
  line: number;
  message: string;
}

export interface AdvParseResult {
  commands: ScriptCommand[];
  errors: AdvSyntaxIssue[];
}

interface Line {
  no: number;
  indent: number;
  text: string;
}

const KEYWORDS = new Set([
  'bg',
  'show',
  'hide',
  'say',
  'narrate',
  'think',
  'bgm',
  'sfx',
  'voice',
  'cg',
  'video',
  'effect',
  'wait',
  'set',
  'point',
  'jump',
  'choice',
  'if',
  'else',
]);

const ID = /^[a-z][a-z0-9_]*$/;
const VAR = /^[a-z][a-z0-9_.]*$/;
const QUOTES: Record<string, string> = { '"': '"', '“': '”', '「': '」' };

class ParseError extends Error {}

/** 读一个带引号的字符串，返回内容和剩下的部分。 */
function readString(s: string): [string, string] | null {
  const open = s[0];
  if (!open || !(open in QUOTES)) return null;
  if (open === '"') {
    // JSON 字符串：支持 \" 和 \n 等转义
    let i = 1;
    while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1;
    if (i >= s.length) throw new ParseError('字符串缺少结尾的引号');
    try {
      return [JSON.parse(s.slice(0, i + 1)) as string, s.slice(i + 1).trim()];
    } catch {
      throw new ParseError('字符串里的转义写错了');
    }
  }
  const close = QUOTES[open] as string;
  const end = s.indexOf(close, 1);
  if (end < 0) throw new ParseError(`字符串缺少结尾的 ${close}`);
  return [s.slice(1, end), s.slice(end + 1).trim()];
}

function needString(s: string, what: string): string {
  const r = readString(s.trim());
  if (!r) throw new ParseError(`${what}要写在引号里`);
  if (r[1]) throw new ParseError(`${what}后面多了内容：${r[1]}`);
  return r[0];
}

/** 读一个 JSON 对象（花括号配对，忽略字符串里的括号），返回对象和剩下的部分。 */
function readJson(s: string): [unknown, string] {
  if (s[0] !== '{') throw new ParseError('条件要写成 JSON 结构，例如 {"gte": ["affinity.char_lin", 50]}');
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        return [JSON.parse(s.slice(0, i + 1)), s.slice(i + 1).trim()];
      } catch {
        throw new ParseError('条件不是合法的 JSON');
      }
    }
  }
  throw new ParseError('条件的花括号没有配对');
}

function readCondition(s: string): [Condition, string] {
  const [raw, rest] = readJson(s);
  const r = Condition.safeParse(raw);
  if (!r.success) throw new ParseError(`条件的结构不对：${JSON.stringify(raw)}`);
  return [r.data, rest];
}

function parseValue(raw: string): Scalar {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const str = readString(raw);
  if (str) {
    if (str[1]) throw new ParseError(`值后面多了内容：${str[1]}`);
    return str[0];
  }
  const n = Number(raw);
  if (raw === '' || !Number.isFinite(n)) throw new ParseError(`看不懂这个值：${raw}`);
  return n;
}

/** set 的参数：`affinity.char_lin +5`、`flags.met true`、`money =10`、`route "lin"`。 */
function parseSet(args: string): VarEffect {
  const m = /^(\S+)\s+(.+)$/.exec(args.trim());
  if (!m) throw new ParseError('set 的写法是：set 变量 +5 / -5 / =值');
  const id = m[1] as string;
  if (!VAR.test(id)) throw new ParseError(`变量 id 不合法：${id}`);
  let raw = (m[2] as string).trim();
  let op: VarEffect['op'] = '=';
  if (/^[+-]\s*\d/.test(raw)) {
    op = raw[0] as '+' | '-';
    raw = raw.slice(1).trim();
  } else if (raw.startsWith('=')) raw = raw.slice(1).trim();
  const value = parseValue(raw);
  if (op !== '=' && typeof value !== 'number') throw new ParseError('+ / - 后面只能是数字');
  return VarEffect.parse({ var: id, op, value });
}

/** check 的参数：`attr.wit dc 12`、`dc 12`（纯运气）、`- dc 12 id lock`。 */
function parseCheck(args: string, label: string): CheckSpec {
  const t = args.trim().split(/\s+/);
  let i = 0;
  let v: string | undefined;
  if (t[i] && t[i] !== 'dc') {
    if (t[i] !== '-') {
      if (!VAR.test(t[i] as string)) throw new ParseError(`检定的变量 id 不合法：${t[i]}`);
      v = t[i];
    }
    i++;
  }
  if (t[i] !== 'dc') throw new ParseError('检定的写法是：check 属性变量 dc 难度，例如 check attr.wit dc 12');
  const dc = Number(t[i + 1]);
  if (!Number.isInteger(dc) || dc < 1 || dc > 40) throw new ParseError('检定难度 dc 要是 1～40 的整数');
  i += 2;
  let id: string | undefined;
  if (t[i] === 'id') {
    id = t[i + 1];
    if (!id) throw new ParseError('id 后面缺少检定 id');
    i += 2;
  }
  if (i < t.length) throw new ParseError(`检定后面多了内容：${t.slice(i).join(' ')}`);
  return { ...(id ? { id } : {}), ...(v ? { var: v } : {}), dc, label };
}

function parseOption(text: string, no: number): ChoiceOption {
  const first = readString(text);
  if (!first) throw new ParseError('选项要以带引号的选项文字开头，例如 "我是来找你的" -> set affinity.char_lin +5');
  const [label, afterLabel] = first;
  const opt: ChoiceOption = { label, set: [], body: [], line: no };
  let rest = afterLabel;
  if (rest.startsWith('if ') || rest.startsWith('if{')) {
    const [cond, r] = readCondition(rest.slice(2).trim());
    opt.if = cond;
    rest = r;
  }
  if (rest.startsWith('check ')) {
    const arrow = rest.indexOf('->');
    const args = arrow < 0 ? rest.slice(6) : rest.slice(6, arrow);
    opt.check = parseCheck(args, label);
    rest = arrow < 0 ? '' : rest.slice(arrow).trim();
  }
  if (rest.startsWith('->')) {
    for (const part of rest
      .slice(2)
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const [word, ...args] = part.split(/\s+/);
      if (word === 'set') opt.set.push(parseSet(args.join(' ')));
      else if (word === 'goto') {
        const to = args[0];
        if (!to || !ID.test(to) || args.length > 1) throw new ParseError('goto 后面要写一个幕 id');
        if (opt.goto) throw new ParseError('一个选项只能 goto 一次');
        opt.goto = to;
      } else throw new ParseError(`选项的效果只能是 set 或 goto，看不懂：${part}`);
    }
    rest = '';
  }
  if (rest) throw new ParseError(`选项后面多了内容：${rest}`);
  return opt;
}

/** 解析一行普通指令（不含 choice / if 这两种带缩进块的）。 */
function parseCommand(text: string, no: number): ScriptCommand {
  const quoted = readString(text);
  if (quoted) {
    if (quoted[1]) throw new ParseError(`旁白后面多了内容：${quoted[1]}`);
    return { op: 'narrate', text: quoted[0], line: no };
  }
  const m = /^(\S+)\s*(.*)$/.exec(text) as RegExpExecArray;
  const word = m[1] as string;
  const args = (m[2] ?? '').trim();
  const words = args ? args.split(/\s+/) : [];
  const one = (what: string) => {
    if (words.length !== 1) throw new ParseError(`${word} 后面要写一个${what}`);
    return words[0] as string;
  };
  switch (word) {
    case 'bg':
      if (!words.length || words.length > 2) throw new ParseError('bg 的写法是：bg 背景 id [转场]');
      return { op: 'bg', id: words[0] as string, ...(words[1] ? { transition: words[1] } : {}), line: no };
    case 'show':
      if (!words.length || words.length > 3) throw new ParseError('show 的写法是：show 角色 [表情] [位置]');
      return {
        op: 'show',
        char: words[0] as string,
        ...(words[1] ? { expr: words[1] } : {}),
        ...(words[2] ? { pos: words[2] } : {}),
        line: no,
      };
    case 'hide':
      return { op: 'hide', char: one('角色'), line: no };
    case 'say': {
      const sm = /^(\S+)\s+(.+)$/.exec(args);
      if (!sm) throw new ParseError('say 的写法是：say 角色 "台词"');
      return { op: 'say', char: sm[1] as string, text: needString(sm[2] as string, '台词'), line: no };
    }
    case 'narrate':
      return { op: 'narrate', text: needString(args, '旁白'), line: no };
    case 'think': {
      if (readString(args)) return { op: 'think', text: needString(args, '内心独白'), line: no };
      const tm = /^(\S+)\s+(.+)$/.exec(args);
      if (!tm) throw new ParseError('think 的写法是：think "内心独白" 或 think 角色 "内心独白"');
      return { op: 'think', char: tm[1] as string, text: needString(tm[2] as string, '内心独白'), line: no };
    }
    case 'bgm': {
      const id = one('音乐 id（或 stop）');
      return { op: 'bgm', id: id === 'stop' ? null : id, line: no };
    }
    case 'sfx':
    case 'voice':
    case 'cg':
    case 'video':
      return { op: word, id: one('素材 id'), line: no };
    case 'effect':
      return { op: 'effect', name: one('效果名'), line: no };
    case 'wait': {
      const s = Number(one('秒数'));
      if (!Number.isFinite(s) || s < 0) throw new ParseError('wait 后面要写秒数');
      return { op: 'wait', seconds: s, line: no };
    }
    case 'set':
      return { op: 'set', effect: parseSet(args), line: no };
    case 'point': {
      const id = one('要点 id');
      if (!ID.test(id)) throw new ParseError(`要点 id 不合法：${id}`);
      return { op: 'point', id, line: no };
    }
    case 'jump': {
      const to = one('幕 id');
      if (!ID.test(to)) throw new ParseError(`幕 id 不合法：${to}`);
      return { op: 'jump', to, line: no };
    }
    case 'else':
      throw new ParseError('else 前面要有对应的 if');
    default: {
      // 角色台词：角色 "台词"
      if (!KEYWORDS.has(word) && readString(args)) return { op: 'say', char: word, text: needString(args, '台词'), line: no };
      throw new ParseError(`看不懂这一行：${text}`);
    }
  }
}

function toLines(text: string): Line[] {
  const out: Line[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const expanded = raw.replace(/\t/g, '    ');
    const body = expanded.trim();
    if (!body || body.startsWith('#')) return;
    out.push({ no: i + 1, indent: expanded.length - expanded.trimStart().length, text: body });
  });
  return out;
}

export function parseAdv(text: string): AdvParseResult {
  const lines = toLines(text.replace(/^﻿/, ''));
  const errors: AdvSyntaxIssue[] = [];
  let i = 0;

  const fail = (line: Line, err: unknown) => {
    if (!(err instanceof ParseError)) throw err;
    errors.push({ line: line.no, message: err.message });
  };

  /** 跳过比 indent 更深的行（出错的块）。 */
  const skipDeeper = (indent: number) => {
    while (i < lines.length && (lines[i] as Line).indent > indent) i++;
  };

  /** 读一个缩进块：所有缩进和第一行相同的行，遇到更浅的行结束。 */
  const block = (parentIndent: number): ScriptCommand[] => {
    const out: ScriptCommand[] = [];
    const first = lines[i];
    if (!first || first.indent <= parentIndent) return out;
    const indent = first.indent;
    while (i < lines.length) {
      const line = lines[i] as Line;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        errors.push({ line: line.no, message: '缩进不对：这一行前面没有 choice、选项或 if' });
        skipDeeper(indent);
        continue;
      }
      i++;
      try {
        if (line.text === 'choice') {
          const options: ChoiceOption[] = [];
          const optIndent = lines[i]?.indent ?? 0;
          if (!lines[i] || optIndent <= indent) throw new ParseError('choice 下面至少要有一个缩进的选项');
          while (i < lines.length && (lines[i] as Line).indent === optIndent) {
            const ol = lines[i] as Line;
            i++;
            try {
              const opt = parseOption(ol.text, ol.no);
              opt.body = block(optIndent);
              options.push(opt);
            } catch (err) {
              fail(ol, err);
              skipDeeper(optIndent);
            }
          }
          if (i < lines.length && (lines[i] as Line).indent > indent) {
            errors.push({ line: (lines[i] as Line).no, message: '选项的缩进要对齐' });
            skipDeeper(indent);
          }
          out.push({ op: 'choice', options, line: line.no });
        } else if (line.text.startsWith('if ') || line.text.startsWith('if{')) {
          const [cond, rest] = readCondition(line.text.slice(2).trim());
          if (rest) throw new ParseError(`条件后面多了内容：${rest}`);
          const then = block(indent);
          let otherwise: ScriptCommand[] = [];
          const next = lines[i];
          if (next && next.indent === indent && next.text === 'else') {
            i++;
            otherwise = block(indent);
          }
          out.push({ op: 'if', cond, then, else: otherwise, line: line.no });
        } else {
          out.push(parseCommand(line.text, line.no));
        }
      } catch (err) {
        fail(line, err);
        skipDeeper(indent);
      }
    }
    return out;
  };

  const commands: ScriptCommand[] = [];
  while (i < lines.length) {
    commands.push(...block(-1));
    // 第一行如果缩进了，block 会把它当作整个文件的缩进；更浅的行另起一块
  }
  return { commands, errors };
}

/** 遍历剧本里的每一条指令（含选项和 if 的内部），结构检查用。 */
export function walkScript(
  commands: readonly ScriptCommand[],
  visit: (c: ScriptCommand) => void,
  visitOption?: (o: ChoiceOption) => void,
): void {
  for (const c of commands) {
    visit(c);
    if (c.op === 'choice') {
      for (const o of c.options) {
        visitOption?.(o);
        walkScript(o.body, visit, visitOption);
      }
    } else if (c.op === 'if') {
      walkScript(c.then, visit, visitOption);
      walkScript(c.else, visit, visitOption);
    }
  }
}
