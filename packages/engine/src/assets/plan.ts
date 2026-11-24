import { createHash } from 'node:crypto';
import type { AssetIndex, AssetKind, AssetSettings, AssetSlotRecord, AssetToggle } from '@auto-adv/schema';
import { parseAdv, walkScript } from '../plot/adv.ts';
import type { WorldData } from '../world/store.ts';
import { AVOID, BUILTIN_TEMPLATES, COMPOSITION, DEFAULT_ART_STYLE, renderTemplate } from './templates.ts';

/**
 * 素材清单（18.2）：从世界算出它现在需要哪些槽、每个槽的生成参数。纯函数，不读写文件。
 * M4 第 1 步只有背景：每个地点一张（AI 演出时舞台用地点 id 当背景 id），
 * 再加上手写剧本里 `bg <id>` 用到、又不是地点 id 的背景，每个 id 一张。
 */

export interface SlotParams {
  prompt: string;
  /** 反向提示词（支持的接口才用；OpenAI 风格的接口已经写在 prompt 里）。 */
  negative: string;
  size: string;
  seed: number;
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
    base: Omit<PlannedSlot, 'params' | 'paramsHash' | 'defaultPrompt'> & { defaultPrompt: string; negative: string; size: string },
  ) => {
    const rec: AssetSlotRecord | undefined = index.slots[base.id];
    const variant = rec?.variant ?? 0;
    const prompt = rec?.prompt?.trim() ? rec.prompt.trim() : base.defaultPrompt;
    const params: SlotParams = { prompt, negative: base.negative, size: base.size, seed: seedOf(base.id, variant) };
    const { negative: _n, size: _s, ...rest } = base;
    out.push({ ...rest, params, paramsHash: hashOf([base.kind, params.prompt, params.negative, params.size, variant]) });
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

/** 输入哈希：生成参数 + 依赖槽现在的文件。依赖重画了，下游就过期。 */
export function inputHashOf(slot: PlannedSlot, index: AssetIndex): string {
  if (slot.deps.length === 0) return slot.paramsHash;
  return hashOf([slot.paramsHash, ...slot.deps.map((d) => index.slots[d]?.builtInput ?? '')]);
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
