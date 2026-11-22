/**
 * 剧情图相关的命令：check-plot（结构检查）和 adv（在命令行里玩剧情 ADV，不调模型）。
 */
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  AdvSession,
  checkWorldPlot,
  endingProgress,
  isStuck,
  loadAdvWorld,
  OUTCOME_LABELS,
  type PlayEvent,
  PlayDb,
  type PlotIssue,
  type PlotMenu,
  type PlotState,
  type WorldData,
  WorldStore,
} from '@auto-adv/engine';

type StageCommand = NonNullable<PlayEvent['stage']>[number];

export interface PlotCliOptions {
  dataDir?: string;
  /** adv：按顺序使用的选项编号（从 1 开始），用完之后交互选择或选第一个能选的。 */
  choose?: string;
  /** adv：play.db 放在哪里，默认 <世界>/playthroughs/play.db。 */
  db?: string;
}

/** <世界> 可以是世界文件夹的路径，也可以是 --data-dir 里的世界 id。 */
async function openWorld(arg: string | undefined, o: PlotCliOptions): Promise<{ world: WorldData; dir: string }> {
  if (!arg) throw new Error('缺少世界：给世界文件夹的路径，或者 --data-dir 里的世界 id');
  const abs = path.resolve(arg);
  if (existsSync(path.join(abs, 'world.json'))) {
    const store = new WorldStore(path.dirname(abs));
    return { world: await store.load(path.basename(abs)), dir: abs };
  }
  const store = new WorldStore(path.join(path.resolve(o.dataDir ?? path.join(os.tmpdir(), 'auto-adv-cli')), 'worlds'));
  return { world: await store.load(arg), dir: store.dir(arg) };
}

const where = (i: PlotIssue) => (i.scene ? `${i.scene}${i.line ? `:${i.line}` : ''}  ` : '');

export async function checkPlotCommand(arg: string | undefined, o: PlotCliOptions): Promise<number> {
  const { world } = await openWorld(arg, o);
  const r = checkWorldPlot(world);
  if (!world.graph || !r) {
    console.log(`《${world.manifest.title}》还没有剧情图（plot/outline.json）。`);
    return 1;
  }
  const g = world.graph;
  const endings = g.scenes.filter((s) => s.ending);
  console.log(`《${world.manifest.title}》的剧情图${world.plot ? '（从 M2 的旧骨架自动迁移）' : ''}`);
  console.log(
    `  ${g.scenes.length} 幕（${endings.length} 个结局，其中隐藏 ${endings.filter((s) => s.ending?.hidden).length} 个）` +
      ` · ${g.chapters.length} 章 · ${world.variables.length} 个变量 · ${Object.keys(world.scripts).length} 份手写剧本`,
  );
  if (r.errors.length) {
    console.log(`\n✕ 错误 ${r.errors.length} 个（修好之前不能开始 ADV 周目）`);
    for (const e of r.errors) console.log(`  ${where(e)}${e.message}`);
  }
  if (r.warnings.length) {
    console.log(`\n! 警告 ${r.warnings.length} 个`);
    for (const w of r.warnings) console.log(`  ${where(w)}${w.message}`);
  }
  console.log(r.ok ? `\n✓ 通过${r.warnings.length ? '（有警告）' : ''}` : '\n✕ 没有通过');
  return r.ok ? 0 : 1;
}

// ───────────── adv ─────────────

const EXIT_REASONS = {
  auto: '条件成立，自动',
  script: '剧本',
  choice: '玩家选择',
  single: '唯一的路',
  default: '演满了，默认',
  director: '导演判断',
} as const;

function stageLine(c: StageCommand, name: (token: string) => string): string | null {
  switch (c.op) {
    case 'say':
      return `${name(c.char)}：「${c.text}」`;
    case 'narrate':
      return c.text;
    case 'think':
      return c.char ? `${name(c.char)}（心想）：${c.text}` : `（${c.text}）`;
    case 'bg':
      return `［背景：${c.id}${c.transition ? ` · ${c.transition}` : ''}］`;
    case 'bgm':
      return `［音乐：${c.id ?? '停止'}］`;
    case 'cg':
      return `［CG：${c.id}］`;
    case 'sfx':
    case 'voice':
    case 'video':
      return `［${{ sfx: '音效', voice: '语音', video: '视频' }[c.op]}：${c.id}］`;
    case 'effect':
      return `［效果：${c.name}］`;
    default:
      return null; // show / hide / wait 在命令行里不显示
  }
}

export async function advCommand(arg: string | undefined, o: PlotCliOptions): Promise<number> {
  const { world, dir } = await openWorld(arg, o);
  const { adv, check } = loadAdvWorld(world);
  const g = adv.graph;
  const sceneOf = (id: string) => g.scenes.find((s) => s.id === id);
  const varLabel = (id: string) => world.variables.find((v) => v.id === id)?.label || id;
  const charName = (token: string) =>
    world.characters.find((c) => c.id === token || c.id === `char_${token}` || c.name === token)?.name ?? token;

  const db = new PlayDb(path.resolve(o.db ?? path.join(dir, 'playthroughs', 'play.db')));
  try {
    const session = new AdvSession(db, adv);
    const protagonist = world.characters.find((c) => c.role === 'protagonist')?.id ?? null;
    const pt = session.start(`cli ${new Date().toLocaleString()}`, protagonist);
    const warned = check.warnings.length ? `（结构检查有 ${check.warnings.length} 个警告）` : '';
    console.log(`《${world.manifest.title}》剧情 ADV · 新周目 ${pt}${warned}`);

    const queue = (o.choose ?? '')
      .split(/[,，\s]+/)
      .filter(Boolean)
      .map((x) => Number(x) - 1);
    const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
    let lastScene: string | null = null;
    let lastChapter: string | null = null;
    const picks: number[] = [];

    const printMenu = (menu: PlotMenu) => {
      console.log(`  ▸ ${menu.source === 'exits' ? '接下来去哪里？' : '选择：'}`);
      menu.options.forEach((opt, i) => {
        const chk = opt.check ? `［检定：${opt.check.var ? `${varLabel(opt.check.var)} ` : ''}dc ${opt.check.dc}］` : '';
        const lock = opt.enabled ? '' : `（锁住${opt.lockedBy ? `：需要 ${opt.lockedBy}` : ''}）`;
        console.log(`    ${i + 1}. ${opt.label}${chk}${lock}`);
      });
    };

    /** 打印新事件；CG 打印出来就算显示过了（跨周目解锁在第一次显示时记）。返回新解锁的 CG 数。 */
    const print = (events: PlayEvent[]): number => {
      let cgs = 0;
      for (const e of events) {
        if (e.kind === 'choice' && e.choice) console.log(`  ▶ 你选了：${e.choice.label}`);
        if (e.kind === 'check' && e.check) {
          const c = e.check;
          const mod = c.var ? ` ${c.modifier >= 0 ? '+' : '-'} ${Math.abs(c.modifier)}（${varLabel(c.var)}）` : '';
          console.log(`  🎲 检定「${c.label}」：d20 = ${c.roll}${mod} = ${c.total}，难度 ${c.dc} → ${OUTCOME_LABELS[c.outcome]}`);
        }
        if (e.kind !== 'script' || !e.plot) continue;
        const m = e.plot;
        const scene = sceneOf(m.scene);
        if (m.scene !== lastScene) {
          const chapter = scene?.chapter ? g.chapters.find((c) => c.id === scene.chapter) : undefined;
          if (chapter && chapter.id !== lastChapter) console.log(`\n════ ${chapter.title || chapter.id} ════`);
          lastChapter = chapter?.id ?? lastChapter;
          console.log(`\n── ${scene?.title || m.scene}（${m.scene}）──`);
          lastScene = m.scene;
        }
        for (const c of e.stage ?? []) {
          const line = stageLine(c, charName);
          if (line) console.log(`  ${line}`);
          if (c.op === 'cg' && session.markShown(pt, e.id, c.id)) cgs++;
        }
        for (const p of m.points ?? []) console.log(`  ✓ 要点：${scene?.points.find((x) => x.id === p)?.text ?? p}`);
        for (const v of m.vars ?? []) console.log(`  ＊ ${varLabel(v.var)}：${String(v.from)} → ${String(v.to)}`);
        for (const n of m.notes ?? []) console.log(`  ! ${n}`);
        if (m.ending) {
          const end = sceneOf(m.ending)?.ending;
          console.log(`  ★ 达成结局「${sceneOf(m.ending)?.title ?? m.ending}」（${end?.kind ?? ''}${end?.hidden ? '，隐藏' : ''}）`);
        }
        if (m.exit) console.log(`  → 前往「${sceneOf(m.exit.to)?.title ?? m.exit.to}」（${EXIT_REASONS[m.exit.by]}）`);
        if (m.menu) printMenu(m.menu);
      }
      return cgs;
    };

    const pick = async (menu: PlotMenu): Promise<number> => {
      const enabled = menu.options.flatMap((x, i) => (x.enabled ? [i] : []));
      while (queue.length) {
        const i = queue.shift() as number;
        if (enabled.includes(i)) return i;
        console.log(`  （--choose 里的 ${i + 1} 现在选不了，跳过）`);
      }
      if (rl) {
        for (;;) {
          const answer = Number((await rl.question('  你的选择：')).trim()) - 1;
          if (enabled.includes(answer)) return answer;
          console.log('  选不了这一项，换一个。');
        }
      }
      return enabled[0] ?? 0;
    };

    let state: PlotState = session.state(pt);
    let unlocked = 0;
    for (let guard = 0; guard < 500 && !state.finished; guard++) {
      if (isStuck(state)) {
        console.log(`\n✕ 卡在「${state.scene?.title}」：剧本演完了，但没有可以走的出口${state.notes.length ? `（${state.notes.join('；')}）` : ''}`);
        break;
      }
      const r = state.menu ? session.choose(pt, await pick(state.menu)) : session.next(pt);
      if (r.events[0]?.kind === 'choice') picks.push((r.events[0].choice?.index ?? 0) + 1);
      unlocked += r.unlocked.length + print(r.events);
      state = r.state;
    }
    rl?.close();

    const prog = endingProgress(g, db.listUnlocks());
    const cgs = db.listUnlocks('cg').length;
    const scenes = db.listUnlocks('scene').length;
    const vars = world.variables
      .filter((v) => v.visible)
      .map((v) => `${v.label} ${String(state.vars[v.id])}`)
      .join(' · ');
    console.log('\n— 周目结束 —');
    console.log(`选择：${picks.join(',') || '（无）'}（用 --choose ${picks.join(',')} 可以重走这条路）`);
    if (vars) console.log(`数值：${vars}`);
    console.log(`走过的幕：${state.visited.join(' → ')}`);
    console.log(
      `跨周目进度：结局 ${prog.reached} / ${prog.total}（${prog.endings
        .filter((e) => !e.hidden || e.reached)
        .map((e) => (e.reached ? e.title : '？？？'))
        .join('、')}）` +
        ` · CG ${cgs} 张 · 走过 ${scenes} / ${g.scenes.length} 幕${unlocked ? ` · 本周目新解锁 ${unlocked} 项` : ''}`,
    );
    return state.finished ? 0 : 1;
  } finally {
    db.close();
  }
}
