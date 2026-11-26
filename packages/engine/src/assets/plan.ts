import { createHash } from 'node:crypto';
import type { AssetIndex, AssetKind, AssetSettings, AssetSlotRecord, AssetToggle, Character, ExpressionDef } from '@auto-adv/schema';
import { parseAdv, walkScript } from '../plot/adv.ts';
import { bgVariantId, resolveSpeaker } from '../plot/stage.ts';
import type { WorldData } from '../world/store.ts';
import {
  AVOID,
  BUILTIN_MUSIC_TEMPLATE,
  BUILTIN_TEMPLATES,
  backdropText,
  COMPOSITION,
  DEFAULT_ART_STYLE,
  DEFAULT_MUSIC_STYLE,
  renderTemplate,
  WHITE_WORDS,
} from './templates.ts';

/**
 * 素材清单（18.2）：从世界算出它现在需要哪些槽、每个槽的生成参数。纯函数，不读写文件。
 * M4 第 1 步只有背景：每个地点一张（AI 演出时舞台用地点 id 当背景 id），
 * 再加上手写剧本里 `bg <id>` 用到、又不是地点 id 的背景，每个 id 一张。
 * 第 2 步加上立绘：每个角色一张基础立绘（平静），再按设置画表情差分（拿基础立绘当参考图改图）。
 * 第 3 步加上 BGM：情绪表里每个情绪一首（bgm/<情绪 id>），用音乐模型生成。本地曲库和内置曲库不是槽（assets/bgm.ts）。
 * 第 5 步加上 CG（手写剧本里的 cg 指令、AI 演出时导演标的高光时刻）和时段背景（bg/<地点 id>@<时段 id>，用到了才画）。
 */

export interface SlotParams {
  prompt: string;
  /** 反向提示词（支持的接口才用；OpenAI 风格的接口已经写在 prompt 里）。 */
  negative: string;
  size: string;
  seed: number;
  /** generate 文生图；edit 拿依赖槽（基础立绘）当参考图改图。 */
  mode: 'generate' | 'edit';
  /** 立绘的透明背景怎么做（18.5）；背景图为 null。 */
  transparency: AssetSettings['transparency'] | null;
  /** 纯色底的颜色；不用纯色底时为 null。 */
  keyColor: 'white' | 'green' | null;
}

export interface PlannedSlot {
  id: string;
  kind: AssetKind;
  /** 受哪个开关控制。 */
  toggle: AssetToggle;
  title: string;
  /** 素材页上的一行说明（地点描述的开头）。 */
  subtitle: string;
  deps: string[];
  params: SlotParams;
  /** 按模板拼出来的提示词（你改过提示词时，params.prompt 是你改的）。 */
  defaultPrompt: string;
  /** 生成参数的哈希：改了提示词、尺寸，或者重抽，都会变。 */
  paramsHash: string;
  /** 文件放在 assets/ 下的哪个子目录、文件名的前缀。 */
  dir: string;
  slug: string;
  /** 背景对应的地点。 */
  locationId?: string;
  /** 手写剧本里的背景：哪几幕用到它（排优先级用）。 */
  sceneIds?: string[];
  /** 立绘：哪个角色、哪个表情。 */
  characterId?: string;
  expression?: string;
  /** BGM：哪个情绪。 */
  mood?: string;
  /** CG：CG id；ai 是导演标的（不是手写剧本里的）。 */
  cgId?: string;
  ai?: boolean;
  /** 时段背景：哪个时段。 */
  timeOfDay?: string;
}

export const hashOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

const seedOf = (id: string, variant: number) => Number.parseInt(hashOf([id, variant]).slice(0, 8), 16) & 0x7fffffff;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return [...t].length > n ? `${[...t].slice(0, n).join('')}…` : t;
};

/** 模板里的公共占位符：画风、世界、避免。 */
function common(world: WorldData, settings: AssetSettings, kind: keyof typeof AVOID) {
  const art = world.style?.art;
  const era = world.brief?.era ?? '';
  const genre = world.brief?.genre ?? '';
  return {
    画风: art?.prompt.trim() || settings.artStyle.trim() || DEFAULT_ART_STYLE,
    世界: [era, genre].filter((x) => x.trim()).join('，'),
    避免: [...AVOID[kind], ...(art?.negative.trim() ? [art.negative.trim()] : [])].join('、'),
  };
}

export function planAssets(world: WorldData, settings: AssetSettings, index: AssetIndex): PlannedSlot[] {
  const out: PlannedSlot[] = [];
  const add = (
    base: Omit<PlannedSlot, 'params' | 'paramsHash' | 'defaultPrompt'> & {
      defaultPrompt: string;
      negative: string;
      size: string;
      mode?: SlotParams['mode'];
      transparency?: SlotParams['transparency'];
      keyColor?: SlotParams['keyColor'];
    },
  ) => {
    const rec: AssetSlotRecord | undefined = index.slots[base.id];
    const variant = rec?.variant ?? 0;
    const prompt = rec?.prompt?.trim() ? rec.prompt.trim() : base.defaultPrompt;
    const params: SlotParams = {
      prompt,
      negative: base.negative,
      size: base.size,
      seed: seedOf(base.id, variant),
      mode: base.mode ?? 'generate',
      transparency: base.transparency ?? null,
      keyColor: base.keyColor ?? null,
    };
    const { negative: _n, size: _s, mode: _m, transparency: _t, keyColor: _k, ...rest } = base;
    // 背景的哈希保持第 1 步的算法（不然升级以后所有背景都算过期）
    const extra = params.transparency
      ? [params.mode, params.transparency, params.keyColor]
      : base.kind === 'cg' || base.toggle === 'timeOfDay'
        ? [params.mode]
        : [];
    out.push({ ...rest, params, paramsHash: hashOf([base.kind, params.prompt, params.negative, params.size, variant, ...extra]) });
  };

  const bgTemplate = settings.templates.background.trim() || BUILTIN_TEMPLATES.background;
  const bgCommon = common(world, settings, 'background');
  for (const loc of world.locations) {
    const values = { ...bgCommon, 内容: [loc.name, loc.description.trim()].filter(Boolean).join('。'), 构图: COMPOSITION.background };
    add({
      id: `bg/${loc.id}`,
      kind: 'background',
      toggle: 'background',
      title: loc.name,
      subtitle: clip(loc.description, 60),
      deps: [],
      defaultPrompt: renderTemplate(bgTemplate, values),
      negative: bgCommon.避免,
      size: settings.sizes.background,
      dir: 'bg',
      slug: loc.id,
      locationId: loc.id,
    });
  }

  // 手写剧本自己起名的背景（同一个地点可以有好几张，比如"门口"和"里面"）
  for (const sb of scriptBackgrounds(world)) {
    if (out.some((p) => p.id === `bg/${sb.id}`)) continue;
    const loc = world.locations.find((l) => l.id === sb.locationId);
    const scene = world.graph?.scenes.find((s) => s.id === sb.sceneIds[0]);
    const content = [loc?.name, loc?.description.trim(), scene?.title, scene?.what.trim(), sb.narration]
      .map((x) => x?.trim().replace(/[。.]+$/, ''))
      .filter(Boolean)
      .join('。');
    const sceneTitles = sb.sceneIds.map((id) => world.graph?.scenes.find((s) => s.id === id)?.title || id);
    add({
      id: `bg/${sb.id}`,
      kind: 'background',
      toggle: 'background',
      title: scene?.title ? `${scene.title} · ${sb.id}` : sb.id,
      subtitle: clip(`剧本里的背景，用在「${sceneTitles.join('」「')}」${loc ? `，地点：${loc.name}` : ''}`, 60),
      deps: [],
      defaultPrompt: renderTemplate(bgTemplate, { ...bgCommon, 内容: content || sb.id, 构图: COMPOSITION.background }),
      negative: bgCommon.避免,
      size: settings.sizes.background,
      dir: 'bg',
      slug: sb.id,
      ...(sb.locationId ? { locationId: sb.locationId } : {}),
      sceneIds: sb.sceneIds,
    });
  }

  // 时段背景（18.4）：故事里用到了才画。默认拿白天的那张当参考图改光线
  const tod = settings.timeOfDay;
  const todTemplate = settings.templates.timeOfDay.trim() || BUILTIN_TEMPLATES.timeOfDay;
  for (const key of index.variants) {
    const [locId = '', vid = ''] = key.split('@');
    const loc = world.locations.find((l) => l.id === locId);
    const v = tod.variants.find((x) => x.id === vid);
    if (!loc || !v || out.some((p) => p.id === `bg/${key}`)) continue;
    const place = [loc.name, loc.description.trim()].filter(Boolean).join('。');
    const light = v.prompt.trim() || v.name;
    const edit = tod.mode === 'edit';
    add({
      id: `bg/${bgVariantId(loc.id, v.id)}`,
      kind: 'background',
      toggle: 'timeOfDay',
      title: `${loc.name} · ${v.name}`,
      subtitle: clip(light, 60),
      deps: edit ? [`bg/${loc.id}`] : [],
      defaultPrompt: edit
        ? renderTemplate(todTemplate, { ...bgCommon, 内容: place, 时段: v.name, 时段描述: light, 构图: COMPOSITION.background })
        : renderTemplate(bgTemplate, { ...bgCommon, 内容: `${place.replace(/[。.]+$/, '')}。${light}`, 构图: COMPOSITION.background }),
      negative: bgCommon.避免,
      size: settings.sizes.background,
      mode: edit ? 'edit' : 'generate',
      dir: 'bg',
      slug: `${loc.id}@${v.id}`,
      locationId: loc.id,
      timeOfDay: v.id,
    });
  }

  // 立绘：基础立绘（平静）→ 表情差分
  const spriteTemplate = settings.templates.sprite.trim() || BUILTIN_TEMPLATES.sprite;
  const exprTemplate = settings.templates.expression.trim() || BUILTIN_TEMPLATES.expression;
  const spriteCommon = common(world, settings, 'sprite');
  const exprAvoid = [...AVOID.expression, ...(world.style?.art.negative.trim() ? [world.style.art.negative.trim()] : [])].join('、');
  const used = scriptExpressions(world);
  for (const c of spriteCharacters(world, settings)) {
    const key = keyColorOf(c, settings);
    const backdrop = backdropText(settings.transparency === 'none' ? null : key);
    const exprs = expressionsOf(c, settings, used.get(c.id));
    const def = (id: string) => expressionDef(id, settings.expressions);
    const neutral = def('neutral');
    const baseId = `sprite/${c.id}/neutral`;
    const content = appearanceOf(c);
    const sprite = { kind: 'sprite' as const, size: settings.sizes.sprite, transparency: settings.transparency, keyColor: settings.transparency === 'none' ? null : key };
    add({
      ...sprite,
      id: baseId,
      toggle: 'sprite',
      title: `${c.name} · ${neutral.name}`,
      subtitle: clip(c.appearance.imagePrompt.trim() || c.appearance.text.trim() || c.summary, 60),
      deps: [],
      defaultPrompt: renderTemplate(spriteTemplate, {
        ...spriteCommon,
        内容: content || c.name,
        表情: neutral.prompt || neutral.name,
        构图: COMPOSITION.sprite,
        背景: backdrop,
      }),
      negative: spriteCommon.避免,
      dir: `sprite/${c.id}`,
      slug: 'neutral',
      characterId: c.id,
      expression: 'neutral',
    });
    for (const e of exprs) {
      if (e === 'neutral') continue;
      const d = def(e);
      add({
        ...sprite,
        id: `sprite/${c.id}/${e}`,
        toggle: 'expression',
        title: `${c.name} · ${d.name}`,
        subtitle: d.prompt || d.name,
        deps: [baseId],
        defaultPrompt: renderTemplate(exprTemplate, { ...spriteCommon, 内容: content || c.name, 表情: d.prompt || d.name, 背景: backdrop, 避免: exprAvoid }),
        negative: exprAvoid,
        mode: 'edit',
        dir: `sprite/${c.id}`,
        slug: e,
        characterId: c.id,
        expression: e,
      });
    }
  }

  // CG（18.6）：手写剧本里的、AI 演出时导演标的。画面里有角色、开着参考图时，拿第一个有立绘的角色的基础立绘当参考图
  const cgTemplate = settings.templates.cg.trim() || BUILTIN_TEMPLATES.cg;
  const cgCommon = common(world, settings, 'cg');
  const drawn = new Set(spriteCharacters(world, settings).map((c) => c.id));
  const addCg = (o: { id: string; title: string; subtitle: string; content: string; cast: string[]; locationId?: string | null; sceneIds?: string[]; ai: boolean }) => {
    const cast = o.cast.flatMap((id) => world.characters.find((c) => c.id === id) ?? []);
    const ref = settings.cg.reference && settings.enabled.sprite ? cast.find((c) => drawn.has(c.id)) : undefined;
    const loc = o.locationId ? world.locations.find((l) => l.id === o.locationId) : undefined;
    const content = [o.content.trim().replace(/[。.]+$/, ''), loc ? `地点：${loc.name}` : ''].filter(Boolean).join('。');
    add({
      id: `cg/${o.id}`,
      kind: 'cg',
      toggle: 'cg',
      title: o.title,
      subtitle: o.subtitle,
      deps: ref ? [`sprite/${ref.id}/neutral`] : [],
      defaultPrompt: renderTemplate(cgTemplate, {
        ...cgCommon,
        内容: content || o.id,
        人物: cast.map((c) => `${c.name}（${appearanceOf(c) || c.summary}）`).join('；'),
        参考: ref
          ? `参考图是${ref.name}的立绘：画面里的${ref.name}要保持参考图里的长相、发型和服装，姿势、表情、背景和构图按上面的画面重新画，不要照搬立绘的姿势和纯色背景`
          : '',
        构图: COMPOSITION.cg,
      }),
      negative: cgCommon.避免,
      size: settings.sizes.cg,
      mode: ref ? 'edit' : 'generate',
      dir: 'cg',
      slug: o.id,
      cgId: o.id,
      ai: o.ai,
      ...(o.locationId ? { locationId: o.locationId } : {}),
      ...(o.sceneIds ? { sceneIds: o.sceneIds } : {}),
    });
  };
  for (const sc of scriptCgList(world)) {
    const scene = world.graph?.scenes.find((x) => x.id === sc.sceneIds[0]);
    const sceneTitles = sc.sceneIds.map((id) => world.graph?.scenes.find((s) => s.id === id)?.title || id);
    const content = [scene?.title, ...sc.narration]
      .map((x) => x?.trim().replace(/[。.]+$/, ''))
      .filter(Boolean)
      .join('。');
    addCg({
      id: sc.id,
      title: scene?.title ? `${scene.title} · ${sc.id}` : sc.id,
      subtitle: clip(`剧本里的 CG，用在「${sceneTitles.join('」「')}」${sc.narration[0] ? `：${sc.narration[0]}` : ''}`, 60),
      content: content || scene?.what || '',
      cast: sc.cast,
      locationId: sc.locationId ?? null,
      sceneIds: sc.sceneIds,
      ai: false,
    });
  }
  for (const [id, def] of Object.entries(index.cgs)) {
    if (out.some((p) => p.id === `cg/${id}`)) continue;
    addCg({
      id,
      title: def.title.trim() || '高光时刻',
      subtitle: clip(def.description, 60),
      content: def.description.trim(),
      cast: def.cast,
      locationId: def.locationId,
      ai: true,
    });
  }

  // BGM：每个情绪一首纯音乐（18.7）
  const musicTemplate = settings.bgm.template.trim() || BUILTIN_MUSIC_TEMPLATE;
  const musicStyle = world.style?.music.description.trim() || DEFAULT_MUSIC_STYLE;
  const worldText = [world.brief?.era ?? '', world.brief?.genre ?? ''].filter((x) => x.trim()).join('，');
  for (const m of settings.bgm.moods) {
    add({
      id: `bgm/${m.id}`,
      kind: 'bgm',
      toggle: 'bgm',
      title: m.name,
      subtitle: m.hint,
      deps: [],
      defaultPrompt: renderTemplate(musicTemplate, { 音乐风格: musicStyle, 世界: worldText, 情绪: m.prompt.trim() || m.name }),
      negative: '',
      size: '',
      dir: 'bgm',
      slug: m.id,
      mood: m.id,
    });
  }
  return out;
}

/** 画图用的外貌：性别、年龄、外貌提示词（没有就用外貌描述）。 */
function appearanceOf(c: Character): string {
  return [c.gender, c.age && /^\d+$/.test(c.age.trim()) ? `${c.age.trim()} 岁` : c.age, c.appearance.imagePrompt.trim() || c.appearance.text.trim()]
    .map((x) => x.trim())
    .filter(Boolean)
    .join('，');
}

/** 要画立绘的角色（设置里可以不画主角）。 */
export function spriteCharacters(world: WorldData, settings: AssetSettings): Character[] {
  return world.characters.filter((c) => settings.spriteProtagonist || c.role !== 'protagonist');
}

/** 主要角色：npc 以外的。 */
export const isMainCharacter = (c: Pick<Character, 'role'>) => c.role !== 'npc';

/** 纯色底用什么颜色：外貌里有白衣、白发这类词时用绿色。 */
export function keyColorOf(c: Character, settings: AssetSettings): 'white' | 'green' {
  if (settings.keyColor !== 'auto') return settings.keyColor;
  return WHITE_WORDS.test(`${c.appearance.imagePrompt} ${c.appearance.text}`) ? 'green' : 'white';
}

/** 表情表里找一个表情；表里没有的（剧本里写的、你删掉的）就用 id 本身当名字。 */
export function expressionDef(id: string, table: readonly ExpressionDef[]): ExpressionDef {
  return table.find((e) => e.id === id) ?? { id, name: id === 'neutral' ? '平静' : id, synonyms: [], prompt: id === 'neutral' ? '表情平静自然' : '' };
}

/**
 * 一个角色画哪些表情：世界里给这个角色单独设了就用它，否则按角色类型（主要 / 其他），
 * 再加上角色自己写的（character.expressions）和手写剧本里用到的。平静（基础立绘）总在第一个。
 */
export function expressionsOf(c: Character, settings: AssetSettings, scriptUsed: readonly string[] = []): string[] {
  const own = settings.characters[c.id]?.expressions;
  const list = own ?? [...(isMainCharacter(c) ? settings.spriteSets.main : settings.spriteSets.other), ...c.expressions, ...scriptUsed];
  return ['neutral', ...new Set(list.filter((e) => e !== 'neutral' && /^[a-z][a-z0-9_]*$/.test(e)))];
}

/** 手写剧本里 show <角色> <表情> 用到的表情，按角色 id。 */
export function scriptExpressions(world: WorldData): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const text of Object.values(world.scripts)) {
    walkScript(parseAdv(text).commands, (cmd) => {
      if (cmd.op !== 'show' || !cmd.expr) return;
      const id = resolveSpeaker(cmd.char, world.characters).characterId;
      if (!id) return;
      const list = out.get(id) ?? [];
      if (!list.includes(cmd.expr)) list.push(cmd.expr);
      out.set(id, list);
    });
  }
  return out;
}

interface ScriptBackground {
  id: string;
  sceneIds: string[];
  /** 第一次出现的那一幕的地点。 */
  locationId?: string;
  /** 换到这张背景之后的第一句旁白，拿来描述画面。 */
  narration?: string;
}

/** 手写剧本里用到的背景 id，按剧情图里幕的顺序。剧本有语法错误也照样认能认出来的部分。 */
export function scriptBackgrounds(world: WorldData): ScriptBackground[] {
  const found = new Map<string, ScriptBackground>();
  for (const scene of world.graph?.scenes ?? []) {
    const text = world.scripts[scene.id];
    if (!text) continue;
    let current: ScriptBackground | null = null;
    walkScript(parseAdv(text).commands, (c) => {
      if (c.op === 'bg') {
        const had = found.get(c.id);
        if (had) {
          if (!had.sceneIds.includes(scene.id)) had.sceneIds.push(scene.id);
          current = null;
        } else {
          current = { id: c.id, sceneIds: [scene.id], ...(scene.location ? { locationId: scene.location } : {}) };
          found.set(c.id, current);
        }
      } else if (c.op === 'narrate' && current && !current.narration) {
        current.narration = c.text;
      }
    });
  }
  return [...found.values()];
}

interface ScriptCg {
  id: string;
  sceneIds: string[];
  locationId?: string;
  /** cg 指令之后（下一个 bg、cg 之前）的旁白，最多三句，拿来描述画面。 */
  narration: string[];
  /** 画面里的角色：cg 时台上的立绘，加上之后开口的角色。 */
  cast: string[];
}

/** 手写剧本里的 CG，按剧情图里幕的顺序。 */
export function scriptCgList(world: WorldData): ScriptCg[] {
  const found = new Map<string, ScriptCg>();
  for (const scene of world.graph?.scenes ?? []) {
    const text = world.scripts[scene.id];
    if (!text) continue;
    let shown: string[] = [];
    let current: ScriptCg | null = null;
    const who = (token: string) => resolveSpeaker(token, world.characters).characterId;
    walkScript(parseAdv(text).commands, (c) => {
      if (c.op === 'bg') {
        shown = [];
        current = null;
      } else if (c.op === 'show') {
        const id = who(c.char);
        if (id && !shown.includes(id)) shown.push(id);
      } else if (c.op === 'hide') {
        const id = who(c.char);
        shown = shown.filter((x) => x !== id);
      } else if (c.op === 'cg') {
        const had = found.get(c.id);
        if (had) {
          if (!had.sceneIds.includes(scene.id)) had.sceneIds.push(scene.id);
          current = null;
        } else {
          current = { id: c.id, sceneIds: [scene.id], ...(scene.location ? { locationId: scene.location } : {}), narration: [], cast: [...shown] };
          found.set(c.id, current);
        }
      } else if (current && c.op === 'narrate') {
        if (current.narration.length < 3) current.narration.push(c.text);
      } else if (current && (c.op === 'say' || c.op === 'think') && c.char) {
        const id = who(c.char);
        if (id && !current.cast.includes(id)) current.cast.push(id);
      }
    });
  }
  return [...found.values()];
}

/**
 * 输入哈希：生成参数 + 依赖槽现在的文件。依赖重画了、换成了你上传的图、换回了之前的图，下游都过期。
 * 文件名里带着它自己的输入哈希（上传的带内容哈希），所以用文件名就够了。
 */
export function inputHashOf(slot: PlannedSlot, index: AssetIndex): string {
  if (slot.deps.length === 0) return slot.paramsHash;
  return hashOf([slot.paramsHash, ...slot.deps.map((d) => index.slots[d]?.file ?? '')]);
}

/** 依赖都画好了没有。 */
export function depsReady(slot: PlannedSlot, index: AssetIndex): boolean {
  return slot.deps.every((d) => !!index.slots[d]?.file);
}

export type SlotStatus = 'pending' | 'running' | 'done' | 'stale' | 'failed' | 'disabled';

export interface SlotState {
  status: SlotStatus;
  /** 过期的原因：params 是这个槽自己的参数改了（等你确认才重画）；deps 是上游重画了（自动跟上）。 */
  staleBy: 'params' | 'deps' | null;
  /** 锁定的槽，上游或参数改过。 */
  upstreamChanged: boolean;
}

export function slotState(slot: PlannedSlot, index: AssetIndex, opts: { running: boolean; enabled: boolean }): SlotState {
  const rec = index.slots[slot.id];
  const input = inputHashOf(slot, index);
  if (opts.running) return { status: 'running', staleBy: null, upstreamChanged: false };
  if (rec?.file) {
    if (rec.builtInput === input) return { status: 'done', staleBy: null, upstreamChanged: false };
    if (rec.locked) return { status: 'done', staleBy: null, upstreamChanged: true };
    return { status: 'stale', staleBy: rec.builtParams === slot.paramsHash ? 'deps' : 'params', upstreamChanged: false };
  }
  if (!opts.enabled) return { status: 'disabled', staleBy: null, upstreamChanged: false };
  if (rec?.error && rec.failedInput === input && !rec.requested) return { status: 'failed', staleBy: null, upstreamChanged: false };
  return { status: 'pending', staleBy: null, upstreamChanged: false };
}

/** 现在该不该自动排队：没画过的、上游重画了的、你点了重画的。参数改了的过期槽要你确认（18.11）。 */
export function wantsWork(slot: PlannedSlot, index: AssetIndex, opts: { running: boolean; enabled: boolean }): boolean {
  const rec = index.slots[slot.id];
  if (opts.running || !opts.enabled || rec?.locked || !depsReady(slot, index)) return false;
  const st = slotState(slot, index, opts);
  if (rec?.requested) return true;
  return st.status === 'pending' || (st.status === 'stale' && st.staleBy === 'deps');
}

/** 游玩时"马上要用"的东西（18.3）：当前的地点和在场角色、当前这一幕和紧接着的幕。 */
export interface AssetFocus {
  locationId: string | null;
  characterIds: string[];
  sceneId: string | null;
}

/** 优先级，数字越小越先画（18.3）。 */
export function priorityOf(slot: PlannedSlot, world: WorldData, focus: AssetFocus | null): number {
  const graph = world.graph;
  const sceneId = focus?.sceneId ?? graph?.start ?? null;
  const scene = graph?.scenes.find((s) => s.id === sceneId);
  const next = new Set((scene?.exits ?? []).map((e) => e.to));
  const soonLocations = new Set<string>(
    [scene?.location, ...(graph?.scenes ?? []).filter((s) => next.has(s.id)).map((s) => s.location)].filter(
      (x): x is string => !!x,
    ),
  );
  const here = focus ? focus.locationId : (world.opening?.locationId ?? null);
  if (slot.kind === 'sprite') {
    // 在场角色的基础立绘最先，其次是这一幕和紧接着的幕要出场的，再其次是在场角色的其他表情（18.3）；
    // 其余角色的基础立绘排在其余表情前面：开场写好之前没有"在场角色"，要先让每个人都有一张（19.8）
    const opening = world.opening?.presentCharacterIds ?? [];
    const present = new Set(focus ? focus.characterIds : opening.length ? opening : (scene?.cast ?? []));
    const soon = new Set([...(scene?.cast ?? []), ...(graph?.scenes ?? []).filter((s) => next.has(s.id)).flatMap((s) => s.cast)]);
    const id = slot.characterId ?? '';
    if (slot.expression === 'neutral') return present.has(id) ? 1 : soon.has(id) ? 2 : 4;
    return present.has(id) ? 3 : 5;
  }
  if (slot.kind === 'cg') {
    // 导演标的 CG 要在这一拍还没播完时画好；剧本里的跟着幕走
    if (slot.ai) return 2;
    if (sceneId && slot.sceneIds?.includes(sceneId)) return 2;
    if (slot.sceneIds?.some((id) => next.has(id))) return 3;
    return 5;
  }
  if (slot.kind === 'background' && slot.sceneIds) {
    // 剧本里的背景跟着幕走：这一幕的先画，紧接着的幕其次
    if (sceneId && slot.sceneIds.includes(sceneId)) return 1;
    if (slot.sceneIds.some((id) => next.has(id))) return 2;
    return 4;
  }
  if (slot.kind === 'background') {
    if (slot.locationId && slot.locationId === here) return 1;
    if (slot.locationId && soonLocations.has(slot.locationId)) return 2;
    return 4;
  }
  return 5;
}
