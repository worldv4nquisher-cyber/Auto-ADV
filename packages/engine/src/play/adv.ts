/**
 * 剧情 ADV：没有手写剧本的幕交给 AI 演出（docs/ARCHITECTURE.md 16.2、16.4、17.3）。
 * 一拍 = 玩家的行动（选项或输入，以及引擎掷的骰）+ 这一拍的演出：
 * 导演安排这一拍、报告剧情进度、给出下一步的选项 → 引擎核对 → 演员兼旁白演出来 → 转成舞台指令。
 * 选项和检定、岔路由玩家决定、数值上限这些规则都在引擎里（plot/judge.ts、plot/transition.ts），不靠提示词。
 */
import type { ChatMessage } from '@auto-adv/providers';
import type { Character } from '@auto-adv/schema';
import { z } from 'zod';
import type { BeatMeta, PlayChunk, PlayEvent, PlotMark, SceneState, Segment } from '../api.ts';
import { required, text } from '../genesis/specs.ts';
import type { Meter, ModelGateway } from '../llm/gateway.ts';
import { generateJson, type JsonSpec, stripThinking } from '../llm/structured.ts';
import type { CheckResult } from '../plot/dice.ts';
import { aiMenu, checkSpecOf, judgeBeat, rollFor } from '../plot/judge.ts';
import { cloneState, type PlotState, reducePlot } from '../plot/progress.ts';
import type { AiRequest, EventDraft } from '../plot/runner.ts';
import { buildTimeline, stageFromSegments } from '../plot/stage.ts';
import type { UnlockKind } from './db.ts';
import { clip, renderBrief, renderCharacter, renderLocation, renderRelationships } from '../world/render.ts';
import type { WorldData } from '../world/store.ts';
import { BUDGET, selectLore, transcriptOf } from './context.ts';
import type { SummaryRow } from './db.ts';
import { validatePlan } from './observer/beat.ts';
import { CheckProposal, DirectorOut, directorSpec, PLOT_REPORT_RULES, plotReportExample } from './observer/prompts.ts';
import { checkInstruction, plotSection, sceneBrief } from './plotprompt.ts';
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
- 每一拍都要有变化：新信息、关系变化、意外。让其他角色按自己的目标和性格主动行动，利用他们之间的张力和秘密。
- location 只能填「地点」里列出的名字；present、speakers、reveals 只能填「角色」里列出的名字。临时人物在 plan 里交代就行。
- 这一拍结尾给玩家 2～4 个选项（options）：方向彼此不同、符合${pName}的性格和处境，写成主角要做的事。
  岔路（出口有两个以上）由玩家决定：想让某个选项通往某条路，就在它的 exit 里写目标幕 id；不要自己在 exit 里替玩家选岔路。
  结果不确定、值得掷骰的选项可以带 check；不需要的写 null。结局幕不用给选项。
${PLOT_REPORT_RULES}`;
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
): ChatMessage[] {
  const pName = protagonist?.name ?? '主角';
  const location = world.locations.find((l) => l.id === state.scene.locationId);
  const present = world.characters.filter((c) => state.scene.presentCharacterIds.includes(c.id) && c.id !== protagonist?.id);
  const system = [
    `你是一部剧情 ADV（视觉小说）的「演员兼旁白」。玩家扮演${pName}，其他角色都由你来演，导演会告诉你这一拍要演什么。

# 输出格式（必须严格遵守）
- 角色说话：单独一行，以【角色名】开头，动作和神态写在台词前的括号里。例如：【${present[0]?.name ?? '角色名'}】（抬起头）你来晚了。
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
    user: advDirectorPrompt({ world, state, plot, protagonist, memory: p.summary?.text ?? null, recent, request: p.request, check: optionCheck }),
    spec: advDirectorSpec,
    signal: p.signal,
  });
  const v = validatePlan(world, state, plan);
  const meta: BeatMeta = { plan: plan.plan, strategy: 'merged' };
  if (plan.time.trim()) meta.time = plan.time.trim();
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
    { messages: advWriterMessages(world, playState, protagonist, p.summary?.text ?? null, recent, instruction) },
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
