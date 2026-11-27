/**
 * 改名（docs/ARCHITECTURE.md 20.4"改名"）：角色、地点改了名字以后，找出正文里还写着旧名字的地方，
 * 按"组"（一块内容里的一个字段，剧情图里的一幕）列出来，选了的换成新名字。
 * 只按完整的名字匹配；别的角色、地点的名字里含着旧名字的（"林夕"和"林夕月"）不换。
 * 引用用的是 id，不换也不会断，只是文字里还是旧名字。
 */
import type { RevKey } from './edit.ts';
import type { WorldData } from './store.ts';

/** 一组要换的地方。group 是稳定的键，选好以后原样传回来。 */
export interface RenameHit {
  group: string;
  key: RevKey | `script:${string}`;
  /** 给人看的位置：「苏晚」的经历、剧情图「码头重逢」…… */
  label: string;
  count: number;
  /** 第一处的上下文（旧名字两边各取几个字）。 */
  preview: string;
}

/** 不是正文的字段：id、引用、开关、条件。 */
const SKIP = new Set([
  'id',
  '_meta',
  'formatVersion',
  'to',
  'knownBy',
  'characterId',
  'locationId',
  'presentCharacterIds',
  'connections',
  'cast',
  'location',
  'scope',
  'start',
  'default',
  'chapter',
  'if',
  'set',
  'check',
  'voice',
  'expressions',
  'backgrounds',
  'referenceImage',
  'activation',
  'role',
  'script',
  'control',
  'language',
  'rating',
  'length',
  'defaultMode',
  'pov',
]);

/** 只看正文：跳过 SKIP 里的字段，回调每一段文字；fn 返回新文字时替换。 */
function mapText(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapText(x, fn));
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SKIP.has(k) ? x : mapText(x, fn)]));
  }
  return v;
}

/** 一个替换器：只换不在"受保护的名字"里面的旧名字。 */
function replacer(from: string, to: string, protect: readonly string[]) {
  const guards = [...new Set(protect.filter((p) => p !== from && p.includes(from)))];
  const spans = (s: string) => {
    const out: [number, number][] = [];
    for (const g of guards) for (let i = s.indexOf(g); i >= 0; i = s.indexOf(g, i + 1)) out.push([i, i + g.length]);
    return out;
  };
  const hits = (s: string): number[] => {
    if (!from || !s.includes(from)) return [];
    const blocked = spans(s);
    const out: number[] = [];
    for (let i = s.indexOf(from); i >= 0; i = s.indexOf(from, i + from.length)) {
      if (!blocked.some(([a, b]) => i >= a && i + from.length <= b)) out.push(i);
    }
    return out;
  };
  return {
    hits,
    replace: (s: string) => {
      const at = hits(s);
      if (!at.length) return s;
      let out = '';
      let last = 0;
      for (const i of at) {
        out += s.slice(last, i) + to;
        last = i + from.length;
      }
      return out + s.slice(last);
    },
  };
}

/** 世界里能出现名字的每一组内容：[组键, 内容键, 位置, 取值, 写回]。 */
interface Group {
  group: string;
  key: RenameHit['key'];
  label: string;
  value: unknown;
}

function groupsOf(world: WorldData, self: { kind: 'character' | 'location'; id: string }): Group[] {
  const out: Group[] = [];
  const add = (group: string, key: Group['key'], label: string, value: unknown) => out.push({ group, key, label, value });
  const m = world.manifest;
  add('manifest/title', 'manifest', '世界名', m.title);
  add('manifest/logline', 'manifest', '世界的一句话简介', m.logline);
  if (world.brief) {
    for (const [k, v] of Object.entries(world.brief)) if (!SKIP.has(k)) add(`brief/${k}`, 'brief', `简报的${BRIEF_LABEL[k] ?? k}`, v);
  }
  if (world.style) {
    for (const k of ['prose', 'art', 'music'] as const) add(`style/${k}`, 'style', `风格（${STYLE_LABEL[k]}）`, world.style[k]);
  }
  add('worldview', 'worldview', '世界观', world.worldview);
  for (const c of world.characters) {
    for (const [k, v] of Object.entries(c)) {
      if (SKIP.has(k)) continue;
      // 改名的就是这个角色：他自己的名字已经是新的了
      if (self.kind === 'character' && self.id === c.id && k === 'name') continue;
      const who = self.kind === 'character' && self.id === c.id ? '这个角色' : `「${c.name}」`;
      add(`character:${c.id}/${k}`, `character:${c.id}`, `${who}的${CHARACTER_LABEL[k] ?? k}`, v);
    }
  }
  for (const l of world.locations) {
    for (const [k, v] of Object.entries(l)) {
      if (SKIP.has(k)) continue;
      if (self.kind === 'location' && self.id === l.id && k === 'name') continue;
      const where = self.kind === 'location' && self.id === l.id ? '这个地点' : `地点「${l.name}」`;
      add(`location:${l.id}/${k}`, `location:${l.id}`, `${where}的${k === 'name' ? '名字' : '描述'}`, v);
    }
  }
  for (const e of world.lore) {
    for (const [k, v] of Object.entries(e)) {
      if (SKIP.has(k)) continue;
      add(`lore:${e.id}/${k}`, `lore:${e.id}`, `设定「${e.title}」的${LORE_LABEL[k] ?? k}`, v);
    }
  }
  const g = world.graph;
  if (g) {
    add('plot/premise', 'plot', '剧情图的核心冲突', g.premise);
    add('plot/chapters', 'plot', '剧情图的章节标题', g.chapters);
    add('plot/threads', 'plot', '剧情图的伏笔', g.threads);
    for (const s of g.scenes) add(`plot/scene:${s.id}`, 'plot', `剧情图「${s.title || s.id}」`, s);
  }
  for (const v of world.variables) add(`variables/${v.id}`, 'variables', `数值「${v.label}」的名字`, v.label);
  if (world.opening) {
    add('opening/narration', 'opening', '开场旁白', world.opening.narration);
    add('opening/lines', 'opening', '开场台词', world.opening.lines);
  }
  for (const [sceneId, text] of Object.entries(world.scripts)) {
    const s = g?.scenes.find((x) => x.id === sceneId);
    add(`script:${sceneId}`, `script:${sceneId}`, `「${s?.title || sceneId}」的手写剧本`, text);
  }
  return out;
}

const BRIEF_LABEL: Record<string, string> = { genre: '题材', tone: '基调', logline: '梗概', era: '时代', themes: '主题' };
const STYLE_LABEL = { prose: '文风', art: '画风', music: '音乐' } as const;
const CHARACTER_LABEL: Record<string, string> = {
  name: '名字',
  aliases: '别称',
  gender: '性别',
  age: '年龄',
  summary: '简介',
  appearance: '外貌',
  personality: '性格',
  speech: '说话方式',
  background: '经历',
  goals: '目标',
  secrets: '秘密',
  relationships: '关系',
};
const LORE_LABEL: Record<string, string> = { title: '标题', content: '正文', category: '分类', keys: '关键词' };

/** 别的角色、地点的名字和别称（里面含着旧名字的不换）。 */
function protectedNames(world: WorldData, to: string): string[] {
  return [...world.characters.flatMap((c) => [c.name, ...c.aliases]), ...world.locations.map((l) => l.name), to];
}

/** 列出还写着旧名字的地方。 */
export function findRenames(world: WorldData, from: string, to: string, self: { kind: 'character' | 'location'; id: string }): RenameHit[] {
  from = from.trim();
  if (!from || from === to.trim()) return [];
  const r = replacer(from, to, protectedNames(world, to));
  const out: RenameHit[] = [];
  for (const g of groupsOf(world, self)) {
    let count = 0;
    let preview = '';
    mapText(g.value, (s) => {
      const at = r.hits(s);
      if (at.length && !preview) {
        const i = at[0] as number;
        preview = `${i > 12 ? '…' : ''}${s.slice(Math.max(0, i - 12), i + from.length + 12)}${i + from.length + 12 < s.length ? '…' : ''}`;
      }
      count += at.length;
      return s;
    });
    if (count) out.push({ group: g.group, key: g.key, label: g.label, count, preview });
  }
  return out;
}

/** 改过的内容（还没写盘）：每块一份。 */
export interface RenamePatch {
  manifest?: Pick<WorldData['manifest'], 'title' | 'logline'>;
  brief?: NonNullable<WorldData['brief']>;
  style?: NonNullable<WorldData['style']>;
  worldview?: string;
  characters: WorldData['characters'];
  locations: WorldData['locations'];
  lore: WorldData['lore'];
  graph?: NonNullable<WorldData['graph']>;
  variables?: WorldData['variables'];
  opening?: NonNullable<WorldData['opening']>;
  scripts: Record<string, string>;
  /** 换了几处。 */
  count: number;
}

/** 把选中的组里的旧名字换成新名字。groups 为 'all' 时全部换。 */
export function applyRenames(
  world: WorldData,
  from: string,
  to: string,
  groups: readonly string[] | 'all',
  self: { kind: 'character' | 'location'; id: string },
): RenamePatch {
  const patch: RenamePatch = { characters: [], locations: [], lore: [], scripts: {}, count: 0 };
  from = from.trim();
  if (!from || from === to.trim()) return patch;
  const r = replacer(from, to, protectedNames(world, to));
  const want = (g: string) => groups === 'all' || groups.includes(g);
  const sub = <T>(v: T, g: string): T => {
    if (!want(g)) return v;
    return mapText(v, (s) => {
      const n = r.hits(s).length;
      if (!n) return s;
      patch.count += n;
      return r.replace(s);
    }) as T;
  };
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

  const m = { title: sub(world.manifest.title, 'manifest/title'), logline: sub(world.manifest.logline, 'manifest/logline') };
  if (changed(m, { title: world.manifest.title, logline: world.manifest.logline })) patch.manifest = m;
  if (world.brief) {
    const b = Object.fromEntries(Object.entries(world.brief).map(([k, v]) => [k, SKIP.has(k) ? v : sub(v, `brief/${k}`)])) as typeof world.brief;
    if (changed(b, world.brief)) patch.brief = b;
  }
  if (world.style) {
    const st = { ...world.style, prose: sub(world.style.prose, 'style/prose'), art: sub(world.style.art, 'style/art'), music: sub(world.style.music, 'style/music') };
    if (changed(st, world.style)) patch.style = st;
  }
  const wv = sub(world.worldview, 'worldview');
  if (wv !== world.worldview) patch.worldview = wv;
  const entity = <T extends { id: string }>(x: T, kind: string, skipName: boolean): T =>
    Object.fromEntries(
      Object.entries(x).map(([k, v]) => [k, SKIP.has(k) || (skipName && k === 'name') ? v : sub(v, `${kind}:${x.id}/${k}`)]),
    ) as T;
  for (const c of world.characters) {
    const n = entity(c, 'character', self.kind === 'character' && self.id === c.id);
    if (changed(n, c)) patch.characters.push(n);
  }
  for (const l of world.locations) {
    const n = entity(l, 'location', self.kind === 'location' && self.id === l.id);
    if (changed(n, l)) patch.locations.push(n);
  }
  for (const e of world.lore) {
    const n = entity(e, 'lore', false);
    if (changed(n, e)) patch.lore.push(n);
  }
  if (world.graph) {
    const g = world.graph;
    const n = {
      ...g,
      premise: sub(g.premise, 'plot/premise'),
      chapters: sub(g.chapters, 'plot/chapters'),
      threads: sub(g.threads, 'plot/threads'),
      scenes: g.scenes.map((s) => sub(s, `plot/scene:${s.id}`)),
    };
    if (changed(n, g)) patch.graph = n;
  }
  const vars = world.variables.map((v) => ({ ...v, label: sub(v.label, `variables/${v.id}`) }));
  if (changed(vars, world.variables)) patch.variables = vars;
  if (world.opening) {
    const o = world.opening;
    const n = { ...o, narration: sub(o.narration, 'opening/narration'), lines: sub(o.lines, 'opening/lines') };
    if (changed(n, o)) patch.opening = n;
  }
  for (const [sceneId, text] of Object.entries(world.scripts)) {
    const n = sub(text, `script:${sceneId}`);
    if (n !== text) patch.scripts[sceneId] = n;
  }
  return patch;
}
