/**
 * 剧情 ADV：没有手写剧本的幕交给 AI 演出（docs/ARCHITECTURE.md 16.2、16.4、17.3）。
 * 一拍 = 玩家的行动（选项或输入，以及引擎掷的骰）+ 这一拍的演出：
 * 导演安排这一拍、报告剧情进度、给出下一步的选项 → 引擎核对 → 演员兼旁白演出来 → 转成舞台指令。
 * 选项和检定、岔路由玩家决定、数值上限这些规则都在引擎里（plot/judge.ts、plot/transition.ts），不靠提示词。
 */
import type { ChatMessage } from '@auto-adv/providers';
import { type Character, type ExpressionDef, type MoodDef, PlotScene } from '@auto-adv/schema';
import { z } from 'zod';
import type { BeatMeta, PlayChunk, PlayEvent, PlotMark, SceneState, Segment } from '../api.ts';
import { list, required, text } from '../genesis/specs.ts';
import type { Meter, ModelGateway } from '../llm/gateway.ts';
import { generateJson, type JsonSpec, stripThinking } from '../llm/structured.ts';
import type { CheckResult } from '../plot/dice.ts';
import { aiMenu, checkSpecOf, judgeBeat, rollFor } from '../plot/judge.ts';
import { checkPlot } from '../plot/check.ts';
import { cloneState, maxIdNumber, type PlotState, reducePlot, sceneById } from '../plot/progress.ts';
import type { AiRequest, EventDraft } from '../plot/runner.ts';
import { buildTimeline, stageFromSegments } from '../plot/stage.ts';
import type { UnlockKind } from './db.ts';
import { clip, matchByName, renderBrief, renderCharacter, renderLocation, renderRelationships } from '../world/render.ts';
import type { WorldData } from '../world/store.ts';
import { BUDGET, selectLore, transcriptOf } from './context.ts';
import type { SummaryRow } from './db.ts';
import { validatePlan } from './observer/beat.ts';
import { CheckProposal, DirectorOut, directorSpec, plotReportExample, plotReportRules } from './observer/prompts.ts';
import { checkInstruction, openExits, plotSection, sceneBrief } from './plotprompt.ts';
import { speechRule } from './expressions.ts';
import { moodOfPlan, moodSection } from './moods.ts';
import { parseScript, ScriptStream } from './script.ts';
import { foldState, type StoryState } from './state.ts';

// ───────────── 导演 ─────────────

export const AdvDirectorOut = DirectorOut.extend({
  options: z
    .array(z.object({ label: required, exit: text.default(''), check: CheckProposal }))
    .catch([])
    .default([]),
});
export type AdvDirectorOut = z.infer<typeof AdvDirectorOut>;

export const advDirectorSpec: JsonSpec<AdvDirectorOut> = {
  name: 'adv_beat',
  schema: AdvDirectorOut,
  example: {
    ...(directorSpec.example as Record<string, unknown>),
    ...plotReportExample,
    options: [
      { label: '给玩家看的选项：主角接下来可以做的事（8～20 字）', exit: '选了就走这个出口（目标幕 id）；不换幕就留空', check: null },
      { label: '另一个方向完全不同的选项', exit: '', check: { var: '属性变量 id（纯运气就留空）', dc: 12, label: '要掷骰的行动' } },
    ],
  },
};

function advDirectorSystem(pName: string): string {
  return `你是一部剧情 ADV（视觉小说）的导演。玩家扮演${pName}，通过选项和输入决定${pName}的行动；其他角色由演员扮演。你看得到一切：剧情图、所有角色的秘密、到目前为止发生的事。
你的工作是安排"这一拍"：先演出玩家这次行动的结果，再把场面推进到下一个需要玩家做决定的地方。一拍大约 150～350 字的戏。
原则：
- ${pName}的行动只来自玩家：选项、输入和检定的结果。不要替玩家做新的决定，也不要让${pName}说出玩家没有选的话。
- 按剧情图推进当前这一幕，但不要急：一个要点可以用几拍来铺垫，确实演到了才报告。
- 玩家的行动离开了这一幕要讲的事，也照着玩家的行动演出结果。世界里确实做不到的事可以演成受阻，但不要找理由（拦路、劝阻、让别人代办）把${pName}挡回这一幕；要不要回到这一幕由玩家决定，你只要如实报告 offTrack，引擎会去问玩家。
- 每一拍都要有变化：新信息、关系变化、意外。让其他角色按自己的目标和性格主动行动，利用他们之间的张力和秘密。
- location 只能填「地点」里列出的名字；present、speakers、reveals 只能填「角色」里列出的名字。临时人物在 plan 里交代就行。
- 这一拍结尾给玩家 2～4 个选项（options）：方向彼此不同、符合${pName}的性格和处境，写成主角要做的事。
  岔路（出口有两个以上）由玩家决定：想让某个选项通往某条路，就在它的 exit 里写目标幕 id；不要自己在 exit 里替玩家选岔路。
  结果不确定、值得掷骰的选项可以带 check；不需要的写 null。结局幕不用给选项。
${plotReportRules('adv')}`;
}

interface AdvPromptInput {
  world: WorldData;
  state: StoryState;
  plot: PlotState;
  protagonist: Character | null;
  memory: string | null;
  recent: PlayEvent[];
  request: AiRequest;
  /** 这一拍的检定（玩家选项上的，已经掷过）。 */
  check: CheckResult | null;
  moods?: readonly MoodDef[] | undefined;
}

function actionText(r: AiRequest, pName: string): string {
  if (!r.action) return r.playerAction ? '' : '（没有新的行动：接着上一拍往下演，把场面推进到下一个需要玩家做决定的地方）';
  return r.action.kind === 'choice' ? `玩家选择：${r.action.text}` : `玩家输入的行动（${pName}要做的事）：${r.action.text}`;
}

function advDirectorPrompt(p: AdvPromptInput): string {
  const { world, state, plot, protagonist } = p;
  const pName = protagonist?.name ?? '主角';
  const location = world.locations.find((l) => l.id === state.scene.locationId);
  const present = world.characters.filter((c) => state.scene.presentCharacterIds.includes(c.id)).map((c) => c.name);
  const parts = [
    `# 世界\n${world.brief ? renderBrief(world.manifest, world.brief, world.style) : world.manifest.title}`,
    world.worldview.trim() ? `# 世界观（节选）\n${clip(world.worldview.trim(), 1500)}` : '',
    `# 角色（全部信息，包括秘密）\n${world.characters.map((c) => renderCharacter(c)).join('\n\n')}`,
    `# 角色关系\n${renderRelationships(world.characters) || '（无）'}`,
    `# 地点\n${world.locations.map((l) => renderLocation(l)).join('\n')}`,
    plotSection(world, plot, 'adv'),
    `# 视角\n玩家扮演${pName}。`,
    p.memory ? `# 前情提要\n${p.memory}` : '',
    `# 最近发生的事\n${transcriptOf(world, p.recent, pName) || '（刚刚开场）'}`,
    `# 现在\n地点：${location?.name ?? '未指定'}；在场：${present.join('、') || '无'}${state.time ? `；时间：${state.time}` : ''}`,
    moodSection(p.moods),
  ];
  const act = actionText(p.request, pName);
  if (act) parts.push(`# 玩家这一次的行动\n${act}`);
  if (p.check) parts.push(`# 检定结果（引擎已经掷过，这一拍必须按这个结果演）\n${checkInstruction(p.check)}`);
  parts.push('请安排这一拍。');
  return parts.filter(Boolean).join('\n\n');
}

// ───────────── 演出 ─────────────

function advWriterMessages(
  world: WorldData,
  state: StoryState,
  protagonist: Character | null,
  memory: string | null,
  recent: PlayEvent[],
  instruction: string,
  expressions?: readonly ExpressionDef[],
): ChatMessage[] {
  const pName = protagonist?.name ?? '主角';
  const location = world.locations.find((l) => l.id === state.scene.locationId);
  const present = world.characters.filter((c) => state.scene.presentCharacterIds.includes(c.id) && c.id !== protagonist?.id);
  const system = [
    `你是一部剧情 ADV（视觉小说）的「演员兼旁白」。玩家扮演${pName}，其他角色都由你来演，导演会告诉你这一拍要演什么。

# 输出格式（必须严格遵守）
${speechRule(present[0]?.name ?? '角色名', expressions)}
- 旁白：不带任何前缀的行，用第三人称（开场里如果有「你」，指的是${pName}）。
- 150～350 字，把导演安排的这一拍演出来，停在需要玩家做决定的地方，不要替玩家做决定。
- ${pName}只做玩家选择的事；可以让${pName}说话，但只说和玩家的选择相符的话。
- 角色只能说出他们知道的事；秘密要藏在言行的细节里，导演没安排揭开就不要说破。
- 不要重复之前说过的话，不要写选项、说明、标题或括号外的旁注。`,
    world.brief ? `# 世界\n${renderBrief(world.manifest, world.brief, world.style)}` : '',
    world.worldview.trim() ? `# 世界观\n${clip(world.worldview.trim(), BUDGET.worldview)}` : '',
    protagonist ? `# 主角（玩家扮演）\n${renderCharacter(protagonist, 'short')}` : '',
    `# 在场角色\n${present.map((c) => renderCharacter(c)).join('\n\n') || '（无）'}`,
    `# 当前场景\n${location ? renderLocation(location) : '- （未指定地点）'}${state.time ? `\n时间：${state.time}` : ''}`,
    memory ? `# 前情提要\n${memory}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const lore = selectLore(world.lore, `${transcriptOf(world, recent.slice(-4), pName)}\n${instruction}`);
  const user = [
    `［最近发生的事］\n${transcriptOf(world, recent, pName) || '（刚刚开场）'}`,
    lore.length ? `［相关设定，供参考］\n${lore.map((e) => `- ${e.title}：${e.content}`).join('\n')}` : '',
    instruction,
    '请演出这一拍。',
  ]
    .filter(Boolean)
    .join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ───────────── 一拍 ─────────────

export interface AdvBeatInput {
  gateway: ModelGateway;
  world: WorldData;
  playthroughId: string;
  /** 从开场到当前位置（玩家的行动和检定已经写进去了）。 */
  path: PlayEvent[];
  request: AiRequest;
  protagonist: Character | null;
  summary: SummaryRow | null;
  signal: AbortSignal;
  meter: Meter;
  emit: (c: PlayChunk) => void;
  /** 表情表（台词前括号里的第一个词换表情，18.6）。 */
  expressions?: readonly ExpressionDef[];
  /** 情绪表（导演每一拍报告 mood，舞台按它换 BGM，18.7）。 */
  moods?: readonly MoodDef[] | undefined;
}

/** 导演最多看最近这么多条原文（更早的靠前情提要）。 */
const RECENT_EVENTS = 12;

export async function runAdvBeat(p: AdvBeatInput): Promise<{ draft: EventDraft; unlocks: { kind: UnlockKind; id: string }[] }> {
  const { world, gateway, protagonist } = p;
  const pName = protagonist?.name ?? '主角';
  const state = foldState(world, p.path);
  const plot = state.plot;
  if (!plot?.scene) throw new Error('当前所在的幕在剧情图里找不到了');
  const scene = plot.scene;
  const from = p.summary ? p.path.findIndex((e) => e.id === p.summary?.eventId) + 1 : 0;
  const recent = p.path.slice(from).slice(-RECENT_EVENTS);
  const head = p.path.at(-1);
  // 玩家选项上的检定已经作为检定事件写在前面了
  const optionCheck = head?.kind === 'check' && head.check ? head.check : null;

  // 1. 导演
  p.emit({ type: 'phase', phase: 'thinking' });
  const director = await gateway.forRole('director', 'adv.director', p.meter);
  const { value: plan } = await generateJson(gateway, director, {
    system: advDirectorSystem(pName),
    user: advDirectorPrompt({ world, state, plot, protagonist, memory: p.summary?.text ?? null, recent, request: p.request, check: optionCheck, ...(p.moods ? { moods: p.moods } : {}) }),
    spec: advDirectorSpec,
    signal: p.signal,
  });
  const v = validatePlan(world, state, plan);
  const meta: BeatMeta = { plan: plan.plan, strategy: 'merged' };
  if (plan.time.trim()) meta.time = plan.time.trim();
  const mood = moodOfPlan(plan.mood, p.moods);
  if (mood) meta.mood = mood;
  if (v.reveals.length) meta.reveals = v.reveals;

  // 2. 引擎核对：导演安排里的检定（这一拍没有选项检定时）先掷骰，再核对要点、数值、出口，最后核对给玩家的选项
  let check: CheckResult | null = null;
  if (!scene.ending && !optionCheck) {
    const c = checkSpecOf(plan.check, world.variables);
    if (c.note) v.rejected.push(c.note);
    if (c.spec) check = rollFor(c.spec, `${scene.id}:plan`, plot, { playthroughId: p.playthroughId, parentId: head?.id ?? null });
  }
  const judged = judgeBeat({
    state: plot,
    variables: world.variables,
    mode: 'adv',
    report: plan,
    playerAction: p.request.playerAction,
    check: check ?? optionCheck,
  });
  const mark: PlotMark = judged.mark;
  if (!mark.exit && !mark.menu && !scene.ending) {
    const after = reducePlot(cloneState(plot), { id: '', parentId: null, kind: 'ai', createdAt: 0, plot: mark } as PlayEvent);
    const menu = aiMenu(after, plan.options, world.variables);
    if (menu.menu) mark.menu = menu.menu;
    if (menu.notes.length) mark.notes = [...(mark.notes ?? []), ...menu.notes];
  }
  if (v.rejected.length) meta.rejected = v.rejected;

  // 3. 演出
  p.emit({ type: 'phase', phase: 'writing' });
  const playState: StoryState = { ...state, scene: v.scene, time: meta.time ?? state.time };
  const instruction = [
    sceneBrief(plot),
    actionText(p.request, pName) ? `［${actionText(p.request, pName)}］` : '',
    optionCheck ? checkInstruction(optionCheck) : check ? checkInstruction(check) : '',
    `［导演安排］${plan.plan}`,
    plan.speakers.length ? `［出场顺序］\n${plan.speakers.map((s) => `- ${s.name}${s.intent ? `：${s.intent}` : ''}`).join('\n')}` : '',
    ...v.reveals.map((r) => {
      const name = (id: string) => world.characters.find((c) => c.id === id)?.name ?? id;
      return `［这一拍揭开秘密］${name(r.characterId)}的秘密被${r.to.map(name).join('、')}知道了`;
    }),
  ]
    .filter(Boolean)
    .join('\n');
  const writer = await gateway.forRole('narrator', 'adv.writer', p.meter);
  const stream = new ScriptStream({ cast: world.characters });
  const result = await gateway.run(
    writer,
    { messages: advWriterMessages(world, playState, protagonist, p.summary?.text ?? null, recent, instruction, p.expressions) },
    {
      signal: p.signal,
      onText: (d) => {
        for (const c of stream.push(d)) p.emit({ type: 'seg', ...c });
      },
    },
  );
  let segments: Segment[] = stream.finish();
  if (!segments.length) segments = parseScript(stripThinking(result.text), { cast: world.characters });
  if (!segments.length) throw new Error('这一拍没有生成任何内容，请重试');
  // 说话的人没在场：视为登场
  const scenePresent = new Set(v.scene.presentCharacterIds);
  for (const s of segments) if (s.kind === 'line' && s.characterId) scenePresent.add(s.characterId);
  const nextScene: SceneState = { locationId: v.scene.locationId, presentCharacterIds: [...scenePresent] };

  // 4. 舞台指令
  const before = buildTimeline(p.path, { characters: world.characters }).end;
  const stage = stageFromSegments(segments, {
    characters: world.characters,
    before,
    scene: nextScene,
    protagonistId: protagonist?.id ?? null,
    ...(p.expressions ? { expressions: p.expressions } : {}),
  });

  const prev = state.scene;
  const changed =
    nextScene.locationId !== prev.locationId || nextScene.presentCharacterIds.join() !== prev.presentCharacterIds.join();
  const draft: EventDraft = {
    kind: 'ai',
    segments,
    stage,
    callId: writer.lastCallId(),
    beat: meta,
    plot: mark,
    ...(check ? { check } : {}),
    ...(changed ? { scene: nextScene } : {}),
  };
  return { draft, unlocks: judged.unlocks };
}

// ───────────── 跑偏："就这样走" ─────────────

export const DetourOut = z.object({
  title: required,
  what: required,
  points: list,
  done: text.default(''),
  location: text.default(''),
  cast: list,
  rejoin: text.default(''),
});
export type DetourOut = z.infer<typeof DetourOut>;

export const advDetourSpec: JsonSpec<DetourOut> = {
  name: 'adv_detour',
  schema: DetourOut,
  example: {
    title: '新的一幕的标题（4～12 字）',
    what: '这一幕要发生什么：接着最近跑偏的这段戏，把它写成一个完整的小场面（一两句）',
    points: ['要点：这一幕里陆续要出现的事（1～3 条）'],
    done: '演到什么程度算这一幕演完了（一句话）',
    location: '地点名（只能用「地点」里列出的）',
    cast: ['出场角色名'],
    rejoin: '演完之后接回哪一幕：只能从「演完之后可以接回的幕」里选一个 id',
  },
};

/** 新插进来的一幕演几拍：是一段插曲，比正常的幕短。 */
const DETOUR_BEATS = { min: 1, max: 4 };
/** 新的一幕最多几个要点。 */
const DETOUR_POINTS = 3;

/**
 * "就这样走"之后可以接回的幕：当前这一幕（回来接着演）；当前幕只有一个打开的出口时，也可以直接接到它通往的幕。
 * 当前幕是岔路时不能接到岔路后面的幕（岔路只能由玩家决定）。
 */
export function rejoinTargets(plot: PlotState): string[] {
  const scene = plot.scene;
  if (!scene) return [];
  const exits = openExits(plot);
  return [scene.id, ...(exits.length === 1 && exits[0] ? [exits[0].to] : [])];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 模型写的新幕转成正式的幕：编号接着这个周目的剧情图往后排，只有一个出口，通往接回的幕。 */
export function detourScene(world: Pick<WorldData, 'characters' | 'locations'>, plot: PlotState, raw: DetourOut): { scene: PlotScene; notes: string[] } {
  const current = plot.scene as PlotScene;
  const notes: string[] = [];
  const id = `sc_${pad(maxIdNumber(plot.graph.scenes, 'sc') + 1)}`;
  const targets = rejoinTargets(plot);
  const want = raw.rejoin.trim();
  const byTitle = plot.graph.scenes.find((x) => x.title && x.title === want)?.id;
  let rejoin = targets.find((t) => t === want || t === byTitle);
  if (!rejoin) {
    rejoin = current.id;
    if (want) notes.push(`新的一幕想接回的「${want}」不在可以接回的幕里，改成接回「${current.title || current.id}」`);
  }
  const location = raw.location.trim() ? matchByName(raw.location, [...world.locations])?.id : undefined;
  const cast = [...new Set(raw.cast.flatMap((n) => matchByName(n, [...world.characters])?.id ?? []))];
  const scene = PlotScene.parse({
    id,
    ...(current.chapter ? { chapter: current.chapter } : {}),
    title: raw.title,
    what: raw.what,
    points: raw.points
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, DETOUR_POINTS)
      .map((t, i) => ({ id: `${id}_${i + 1}`, text: t })),
    done: raw.done,
    ...(location ? { location } : {}),
    cast,
    minBeats: DETOUR_BEATS.min,
    maxBeats: DETOUR_BEATS.max,
    exits: [{ to: rejoin, label: '', when: '', auto: false, set: [] }],
  });
  return { scene, notes };
}

function detourPrompt(world: WorldData, plot: PlotState, memory: string | null, transcript: string, pName: string): string {
  const scene = plot.scene as PlotScene;
  const targets = rejoinTargets(plot).map((id) => {
    const t = sceneById(plot, id);
    return `- ${id}「${t?.title || id}」${t?.what ? `：${t.what}` : ''}${id === scene.id ? '（回到刚才这一幕，接着把它演完）' : '（这一幕演完之后本来就要去的地方）'}`;
  });
  return [
    `# 世界\n${world.brief ? renderBrief(world.manifest, world.brief, world.style) : world.manifest.title}`,
    `# 角色\n${world.characters.map((c) => `- ${c.name}${c.summary ? `：${clip(c.summary, 60)}` : ''}`).join('\n')}`,
    `# 地点\n${world.locations.map((l) => `- ${l.name}`).join('\n')}`,
    `# 剧情图上当前这一幕：[${scene.id}] ${scene.title || scene.id}\n${scene.what}${
      scene.points.length ? `\n要点：\n${scene.points.map((p) => `- [${plot.points.has(p.id) ? 'x' : ' '}] ${p.text}`).join('\n')}` : ''
    }`,
    `# 演完之后可以接回的幕\n${targets.join('\n')}`,
    memory ? `# 前情提要\n${memory}` : '',
    `# 最近发生的事\n${transcript || '（刚刚开场）'}`,
    `# 要做的事\n最近几拍，玩家扮演的${pName}离开了这一幕要讲的事，玩家选择"就这样走"。请把跑偏的这段戏写成剧情图上新的一幕，插在当前这一幕后面：
- 接着现在正在发生的事往下写，不要把场面拉回去；
- 这是一段插曲，演 ${DETOUR_BEATS.min}～${DETOUR_BEATS.max} 拍，points 写 1～${DETOUR_POINTS} 个要点；
- 不要提前揭开主线的秘密，也不要替玩家做决定；
- rejoin 从「演完之后可以接回的幕」里选一个，让这段插曲演完之后自然地回到主线上。`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface AdvDetourInput {
  gateway: ModelGateway;
  world: WorldData;
  path: PlayEvent[];
  protagonist: Character | null;
  summary: SummaryRow | null;
  signal: AbortSignal;
  meter: Meter;
  emit: (c: PlayChunk) => void;
}

/**
 * 剧情 ADV 跑偏时玩家选了"就这样走"（16.6）：导演把跑偏的这一段写成新的一幕，插在当前幕后面，演完接回已有的幕。
 * 新的一幕记在 drift 事件上（plot.append），只属于这个周目，要过结构检查；先承诺后判定，已有的幕都不改。
 */
export async function runAdvDetour(p: AdvDetourInput): Promise<EventDraft> {
  const { world, gateway } = p;
  const pName = p.protagonist?.name ?? '主角';
  const state = foldState(world, p.path);
  const plot = state.plot;
  if (!plot?.scene || plot.scene.ending) throw new Error('现在不能把这一段写成新的一幕');
  const current = plot.scene;
  const from = p.summary ? p.path.findIndex((e) => e.id === p.summary?.eventId) + 1 : 0;
  const recent = p.path.slice(from).slice(-RECENT_EVENTS);
  const known = new Set(plot.graph.scenes.map((x) => x.id));
  const check = (raw: DetourOut) => {
    const { scene } = detourScene(world, plot, raw);
    const r = checkPlot({
      graph: { ...plot.graph, start: scene.id, scenes: [scene] },
      variables: world.variables,
      characters: world.characters,
      locations: world.locations,
      known,
    });
    return { scene, errors: r.errors.map((e) => e.message) };
  };

  p.emit({ type: 'phase', phase: 'detour' });
  const director = await gateway.forRole('director', 'adv.detour', p.meter);
  const { value } = await generateJson(gateway, director, {
    system: `你是一部剧情 ADV（视觉小说）的导演，负责维护剧情图。剧情图由"幕"组成，是骨架，不是剧本：只规定每一幕必须发生什么，具体怎么演留给演出时即兴发挥。`,
    user: detourPrompt(world, plot, p.summary?.text ?? null, transcriptOf(world, recent, pName), pName),
    spec: advDetourSpec,
    signal: p.signal,
    validate: (v) => {
      const errors = check(v).errors;
      return errors.length ? `新的一幕有这些问题，请修改：\n${errors.map((e) => `- ${e}`).join('\n')}` : null;
    },
  });
  const { scene, notes } = detourScene(world, plot, value);
  const mark: PlotMark = {
    scene: current.id,
    append: { chapters: [], scenes: [scene] },
    exit: { to: scene.id, by: 'drift' },
    ...(notes.length ? { notes } : {}),
  };
  return { kind: 'drift', drift: 'detour', text: scene.title || scene.id, plot: mark };
}
