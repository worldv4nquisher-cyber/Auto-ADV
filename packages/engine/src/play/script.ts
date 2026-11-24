/**
 * 对话回复的文本格式与解析。纯函数，不依赖 Node，界面也可以直接用。
 *
 * 模型按下面的格式输出（比 JSON 更适合流式显示，小模型也写得对）：
 *   旁白：不带前缀的行
 *   台词：【角色名】（动作）台词
 * 也兼容「角色名：台词」和「角色名（动作）台词」的写法（仅当名字是已知角色时）。
 */
import type { Segment } from '../api.ts';
import { matchByName } from '../world/render.ts';

export interface ScriptCast {
  id: string;
  name: string;
  aliases?: string[];
}

export interface ScriptOptions {
  /** 可以说话的角色（用于把名字对应到角色 id）。 */
  cast: ScriptCast[];
  /** 玩家扮演的角色：模型替主角写的台词会被丢掉。 */
  protagonist?: ScriptCast | null;
}

const TAGGED = /^\s*[【[［]([^】\]］\n]{1,24})[】\]］]\s*(.*)$/;
const COLON = /^\s*([^\s：:「」【】()（）]{1,12})\s*[：:]\s*(.+)$/;
/** 漏了【】的写法：「角色名（动作）台词」。 */
const PAREN = /^\s*([^\s：:「」【】()（）]{1,12})\s*([（(][^（）()\n]{1,40}[）)]\s*.+)$/;
/** 有的模型会给旁白也加前缀：「旁白：……」或「【旁白】……」。 */
const NARRATOR = /^(?:[【[［]\s*旁白\s*[】\]］]|旁白\s*[：:])\s*/;

function isProtagonist(name: string, o: ScriptOptions): boolean {
  return !!o.protagonist && !!matchByName(name, [{ name: o.protagonist.name, aliases: o.protagonist.aliases }]);
}

/** 去掉部分模型写在正文里的思考过程；思考还没结束时返回空串。 */
function stripThink(text: string): string {
  const m = /^\s*<think>/.exec(text);
  if (!m) return text;
  const end = text.indexOf('</think>');
  return end < 0 ? '' : text.slice(end + '</think>'.length);
}

/** 去掉 Markdown 强调：**粗体** 去掉星号，*动作* 改成（动作）。 */
function cleanLine(line: string): string {
  return line
    .replace(/\*\*/g, '')
    .replace(/\*([^*\n]+)\*/g, '（$1）')
    .trim();
}

/** 台词整句被引号包住时去掉引号（「……」或"……"）。 */
function unquote(text: string): string {
  const m = /^「([^「」]*)」$/.exec(text) ?? /^“([^“”]*)”$/.exec(text) ?? /^"([^"]*)"$/.exec(text);
  return m ? (m[1] ?? '') : text;
}

/** 把整段文本解析成台词和旁白。 */
export function parseScript(text: string, o: ScriptOptions): Segment[] {
  const out: Segment[] = [];
  let pending: { characterId: string | null; name: string } | null = null;
  let skipping = false;
  for (const rawLine of stripThink(text).split(/\r?\n/)) {
    const line = cleanLine(rawLine);
    if (!line || /^-{3,}$/.test(line)) continue;
    const narrator = NARRATOR.exec(line);
    if (narrator) {
      skipping = false;
      pending = null;
      const rest = line.slice(narrator[0].length).trim();
      if (rest) out.push({ kind: 'narration', text: rest });
      continue;
    }
    const tagged = TAGGED.exec(line);
    // 没有【】的写法只认已知角色的名字，免得把「时间：午夜」这样的旁白当成台词
    const untagged = tagged ? null : ([COLON.exec(line), PAREN.exec(line)].find((m) => m && matchByName(m[1] ?? '', o.cast)) ?? null);
    const speakerName = tagged?.[1]?.trim() ?? untagged?.[1];
    if (speakerName !== undefined) {
      const rest = unquote((tagged ? tagged[2] : untagged?.[2])?.trim() ?? '');
      skipping = isProtagonist(speakerName, o);
      pending = null;
      if (skipping) continue;
      const who = matchByName(speakerName, o.cast);
      const speaker = { characterId: who?.id ?? null, name: who?.name ?? speakerName };
      if (rest) out.push({ kind: 'line', ...speaker, text: rest });
      else pending = speaker; // 名字单独一行，台词在下一行
      continue;
    }
    if (pending) {
      out.push({ kind: 'line', ...pending, text: unquote(line) });
      pending = null;
      continue;
    }
    // 主角台词后面紧跟的续行也一起丢掉，直到出现新的段落类型
    if (skipping && /^[「“"（(]/.test(line)) continue;
    skipping = false;
    out.push({ kind: 'narration', text: line });
  }
  return out;
}

/** 流式解析：每收到一段增量，返回有变化的段落（index 是在最终结果中的位置）。 */
export class ScriptStream {
  private text = '';
  private segments: Segment[] = [];
  private readonly o: ScriptOptions;

  constructor(o: ScriptOptions) {
    this.o = o;
  }

  push(delta: string): { index: number; seg: Segment }[] {
    this.text += delta;
    // 最后一行如果是没写完的「【名字」，先不显示，免得闪一下旁白
    const lastNl = this.text.lastIndexOf('\n');
    const tail = this.text.slice(lastNl + 1);
    const stable = /^\s*(\*\*)?[【[［][^】\]］]*$/.test(tail) ? this.text.slice(0, lastNl + 1) : this.text;
    return this.update(parseScript(stable, this.o));
  }

  finish(): Segment[] {
    this.update(parseScript(this.text, this.o));
    return this.segments;
  }

  get raw(): string {
    return this.text;
  }

  private update(next: Segment[]): { index: number; seg: Segment }[] {
    const changed: { index: number; seg: Segment }[] = [];
    next.forEach((seg, index) => {
      const prev = this.segments[index];
      if (!prev || JSON.stringify(prev) !== JSON.stringify(seg)) changed.push({ index, seg });
    });
    this.segments = next;
    return changed;
  }
}

/** 段落转回文本格式（用于编辑和拼进上下文）。 */
export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => (s.kind === 'line' ? `【${s.name}】${s.text}` : s.text)).join('\n');
}
