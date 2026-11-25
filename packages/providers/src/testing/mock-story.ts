/**
 * 模拟服务里的"故事模型"：认出创世和游玩的各类请求，返回格式正确的固定内容。
 * 只用于测试和没有 API Key 时把整个流程走通，内容本身没有意义。
 */

export interface MockMessage {
  role: string;
  content: string;
}

export interface MockRequestInfo {
  messages: MockMessage[];
  /** response_format.json_schema.name，或提示词里写明的 schema 名。 */
  schemaName: string | null;
  /** 这是第几次请求（从 1 开始），用来让重抽的结果不一样。 */
  count: number;
}

const NPC_NAMES = ['林夕', '白鸦', '顾长风', '苏芷', '老陈', '米拉', '夜枭', '阿澈'];
const LOCATIONS = [
  { name: '雾港码头', description: '终年笼罩在薄雾里的旧码头，汽笛声和海鸥声混在一起，货箱堆成迷宫。' },
  { name: '灯塔', description: '废弃多年的灯塔，最近却在午夜重新亮起。螺旋楼梯的尽头锁着一扇铁门。' },
  { name: '鲸骨酒馆', description: '用鲸骨做梁的老酒馆，水手和情报贩子在这里交换消息。' },
  { name: '钟楼档案馆', description: '收藏港口百年记录的档案馆，有一整排被人撕掉的卷宗。' },
];

export function schemaNameOf(body: Record<string, unknown>, messages: MockMessage[]): string | null {
  const rf = body.response_format as { type?: string; json_schema?: { name?: string } } | undefined;
  if (rf?.type === 'json_schema' && rf.json_schema?.name) return rf.json_schema.name;
  for (const m of [...messages].reverse()) {
    const hit = /schema 名：(\w+)/.exec(m.content);
    if (hit?.[1]) return hit[1];
  }
  return null;
}

/** 模拟的演出素材：按请求序号轮换，让相邻几拍的文字不一样（重复检测不会误报）。 */
const NARRATION = [
  '雾从海面上漫过来，煤气灯的光晕被揉成一团团昏黄。',
  '码头上的木板吱呀作响，有人在远处收起了渔网。',
  '一阵冷风灌进门缝，桌上的蜡烛晃了晃，差点熄灭。',
  '钟楼敲了十一下，声音在湿漉漉的石板路上滚出很远。',
  '酒馆里的喧闹忽然低了下去，几个水手交换了一下眼色。',
  '灯塔的光扫过窗户，在墙上留下一道转瞬即逝的白痕。',
  '档案馆的书架之间弥漫着纸张发霉的气味，脚步声被吸得很轻。',
  '潮水退了，礁石上露出一串新鲜的脚印，一直通向灯塔。',
];
/** 括号里第一个词是表情（18.6），后面是动作。 */
const ACTIONS = [
  '平静，压低声音',
  '微笑，把杯子推到一边',
  '难过，盯着窗外',
  '惊讶，从怀里掏出一张旧照片',
  '笑了一下',
  '生气，停下脚步',
  '害羞，摸了摸口袋里的钥匙',
  '愣了一下，回头看了一眼',
];
const LINES = [
  '昨晚我又看见那道光了，比上次亮。',
  '守灯人的日志少了最后三页，你知道是谁拿走的吗？',
  '港务局的人今天来过，问了很多奇怪的问题。',
  '别在雾潮之夜靠近礁石，这是老规矩。',
  '我答应过你父亲，要替他守住这件事。',
  '如果你真想知道，明晚跟我去档案馆。',
  '有人在灯塔的铁门上换了一把新锁。',
  '那艘没有名字的船，又在港外停了一夜。',
];
const pick = <T>(arr: T[], i: number): T => arr[((i % arr.length) + arr.length) % arr.length] as T;

/** 从提示词里抠出 "## 名字" 形式的角色列表（某个标题之下）。 */
function namesUnder(text: string, heading: string): string[] {
  const at = text.indexOf(`# ${heading}`);
  if (at < 0) return [];
  const block = text.slice(at).split(/\n# /)[0] ?? '';
  return [...block.matchAll(/^## ([^\s（\n]+)/gm)].map((m) => m[1] as string);
}

function directorPlan(user: string, count: number): string {
  const now = /# 现在\n地点：([^；\n]*)；在场：([^；\n]*)/.exec(user);
  const allNames = namesUnder(user, '角色（全部信息，包括秘密）');
  let present = (now?.[2] ?? '').split('、').filter((n) => n && n !== '无');
  if (!present.length) present = allNames.slice(0, 2);
  // 每隔几拍让一个没在场的角色登场
  const absent = allNames.filter((n) => !present.includes(n));
  if (count % 4 === 0 && absent[0]) present = [...present, absent[0]];
  const locBlock = user.slice(user.indexOf('# 地点')).split(/\n# /)[0] ?? '';
  const locations = [...locBlock.matchAll(/^- ([^：\n]+)：/gm)].map((m) => m[1] as string);
  const here = now?.[1] && now[1] !== '未指定' ? now[1] : (locations[0] ?? '');
  const location = count % 5 === 0 && locations.length > 1 ? pick(locations.filter((l) => l !== here), count) : here;

  const report = plotReport(user);
  const directive = /# 观众的导演指令（尽量满足）\n- (.+)/.exec(user)?.[1];
  const card = /事件卡来打破僵局：「(.+?)」/.exec(user)?.[1];
  const plan = directive
    ? `按观众的要求：${directive}`
    : card
      ? `用事件卡打破僵局：${card}`
      : `（模拟导演 #${count}）${present[0] ?? '众人'}和${present[1] ?? '自己'}围绕灯塔的线索交换情报，气氛逐渐紧张。`;
  // 轮流让不同的人开口
  const order = [...present.slice(count % Math.max(1, present.length)), ...present.slice(0, count % Math.max(1, present.length))];
  const speakers = order.slice(0, 2).map((name, i) => ({ name, intent: i ? '回应，但有所保留' : '抛出新线索' }));
  return JSON.stringify({
    plan,
    location,
    present,
    time: count % 3 === 0 ? `第 ${Math.ceil(count / 3)} 天夜里` : '',
    speakers,
    reveals: count % 6 === 0 && present.length >= 2 ? [{ owner: present[1], to: [present[0]] }] : [],
    // 有「音乐情绪」一节时报一个情绪：每三拍换一个（测换曲要持续几拍）
    mood: moodOf(user, count),
    ...report,
    check: directive?.includes('检定') ? { var: report.attribute ?? '', dc: 12, label: '仔细观察' } : null,
  });
}

function moodOf(user: string, count: number): string {
  const block = (user.split('# 音乐情绪')[1] ?? '').split(/\n# /)[0] ?? '';
  const ids = [...block.matchAll(/^- ([a-z][a-z0-9_]*)（/gm)].map((m) => m[1] as string);
  return ids.length ? (ids[Math.floor((count - 1) / 3) % ids.length] as string) : '';
}

/**
 * 剧情 ADV 的导演：和观察模式一样报告进度，再给玩家三个选项（其中一个带检定）。
 * 岔路演完时引擎会弹出出口菜单，这里不替玩家选路。
 * 玩家输入里有"跑题"就报告偏离了这一幕、不推进（测跑偏时的四个选项）；剧情图暂停时不报告进度。
 */
function advBeat(user: string, count: number): string {
  const plan = JSON.parse(directorPlan(user, count)) as Record<string, unknown> & { present: string[] };
  const action = /# 玩家这一次的行动\n(.+)/.exec(user)?.[1] ?? '';
  const paused = user.includes('玩家暂停了剧情图');
  const drifting = action.includes('跑题') && !user.includes('玩家想回到这一幕');
  const report = paused || drifting ? { ...plotReport(user), points: [], sceneDone: false, exit: '', offTrack: drifting && !paused } : plotReport(user);
  const ending = user.includes('这是结局幕');
  const who = plan.present[0] ?? '对方';
  const options = ending
    ? []
    : [
        { label: `追问${who}灯塔的事`, exit: '', check: null },
        { label: '仔细观察四周', exit: '', check: { var: report.attribute ?? '', dc: 12, label: '仔细观察四周' } },
        { label: '先把话题岔开', exit: '', check: null },
      ];
  return JSON.stringify({ ...plan, ...report, options });
}

/** 剧情 ADV 跑偏时"就这样走"：把跑偏的这一段写成一幕，接回列出的最后一个幕。 */
function advDetour(user: string): string {
  const block = (name: string) => (user.split(`# ${name}`)[1] ?? '').split(/\n# /)[0] ?? '';
  const targets = [...block('演完之后可以接回的幕').matchAll(/^- (sc_\d+)「/gm)].map((m) => m[1] as string);
  const location = /^- (\S+)/m.exec(block('地点'))?.[1] ?? '';
  const who = /^- ([^：\n]+)/m.exec(block('角色'))?.[1] ?? '';
  return JSON.stringify({
    title: '酒馆里的插曲',
    what: '主角在酒馆里打听消息，意外听到了一段传闻。',
    points: ['在酒馆里听到传闻', '有人注意到了主角'],
    done: '主角离开酒馆',
    location,
    cast: who ? [who] : [],
    rejoin: targets.at(-1) ?? '',
  });
}

/**
 * 从导演提示词里的「# 剧情图」读出当前幕：每拍报告一个还没演到的要点，最后一个要点演到时说演完了、走第一个出口；
 * 有关系类数值就每拍 +3。ADV 的岔路不替玩家选（提示词里写了"由玩家决定"）。
 */
function plotReport(user: string) {
  const at = user.indexOf('# 剧情图');
  const block = at >= 0 ? (user.slice(at).split(/\n# /)[0] ?? '') : '';
  const undone = [...block.matchAll(/^- \[ \] (\S+)：/gm)].map((m) => m[1] as string);
  const exits = [...(block.split('## 出口')[1] ?? '').matchAll(/^- (sc_\d+)「/gm)].map((m) => m[1] as string);
  const fork = block.includes('由玩家决定');
  const sceneDone = !!block && !block.includes('这是结局幕') && undone.length <= 1;
  const relation = /^- (affinity\.\S+|trust\.\S+)（/m.exec(block)?.[1];
  const attribute = /^- (skill\.\S+)（/m.exec(block)?.[1];
  return {
    points: undone.slice(0, 1),
    sceneDone,
    exit: sceneDone && !fork ? (exits[0] ?? '') : '',
    offTrack: false,
    set: relation ? [{ var: relation, op: '+', value: 3 }] : [],
    ...(attribute ? { attribute } : {}),
  };
}

/** 剧情图：创世时 6 幕（一个岔路、一个看好感的结局分歧），续写时 3 幕。 */
function plotGraph(user: string, sequel: boolean, count: number): string {
  const cast = [...user.matchAll(/^- (char_\d+)：([^\s（\n]+)(（主角)?/gm)].map((m) => ({ id: m[1] as string, name: m[2] as string, hero: !!m[3] }));
  const heroine = cast.find((c) => !c.hero) ?? cast[0] ?? { id: 'char_02', name: '林夕' };
  const locBlock = user.slice(user.indexOf('# 地点')).split(/\n# /)[0] ?? '';
  const locs = [...locBlock.matchAll(/^- ([^：\n（]+)[：（]/gm)].map((m) => (m[1] as string).trim());
  const loc = (i: number) => locs[i % Math.max(1, locs.length)] ?? '';
  if (sequel) {
    const t = `续篇 ${count}`;
    return JSON.stringify({
      premise: '',
      chapters: [{ title: `${t}：新的潮汐` }],
      variables: [],
      scenes: [
        { id: 'n1', chapter: 1, title: `${t}：余波`, what: '平静之下，新的异常出现了', points: ['新的线索', '旧日的约定'], done: '主角决定追查', location: loc(0), cast: [heroine.name], exits: [{ to: 'n2' }] },
        { id: 'n2', chapter: 1, title: `${t}：风暴前夜`, what: '风暴逼近雾港', points: ['风暴逼近', '众人做出选择'], done: '风暴来临', location: loc(1), exits: [{ to: 'n3' }] },
        { id: 'n3', chapter: 1, title: `${t}：潮汐归来`, what: '风暴过去，雾港迎来新的早晨', ending: { kind: 'good', text: '写出风暴过后的清晨' } },
      ],
      threads: [],
    });
  }
  const aff = `affinity.${heroine.id}`;
  return JSON.stringify({
    premise: '灯塔重新亮起，牵出十年前守灯人失踪的真相，以及整个雾港守护的秘密。',
    chapters: [{ title: '归乡' }, { title: '雾潮之夜' }],
    variables: [
      { id: aff, label: `${heroine.name}的好感`, type: 'number', initial: 30, min: 0, max: 100, category: 'relationship' },
      { id: 'flag.found_log', label: '找到了守灯人日志', type: 'boolean', initial: false, category: 'other' },
      { id: 'skill.insight', label: '洞察', type: 'number', initial: 1, min: -2, max: 5, category: 'attribute' },
    ],
    scenes: [
      {
        id: 'sc_01', chapter: 1, title: '归乡', what: '主角回到雾港，察觉所有人都在隐瞒灯塔的事', points: ['码头重逢', '灯塔又亮了'],
        done: '主角决定怎么调查灯塔', location: loc(0), cast: [heroine.name],
        exits: [
          { to: 'sc_02', label: `和${heroine.name}一起去灯塔`, when: '主角邀请同伴同行' },
          { to: 'sc_03', label: '独自去档案馆', when: '主角决定一个人查' },
        ],
      },
      { id: 'sc_02', chapter: 1, title: '同行', what: `主角和${heroine.name}在雾里走向灯塔`, points: ['并肩走过栈桥', '她说出那晚看到的人影'], done: '两人到了灯塔下', location: loc(1), cast: [heroine.name], exits: [{ to: 'sc_04' }] },
      { id: 'sc_03', chapter: 1, title: '档案馆', what: '主角独自翻查港口的旧档案', points: ['被撕掉的卷宗', '守灯人日志的线索'], done: '找到通往灯塔的线索', location: loc(3), exits: [{ to: 'sc_04' }] },
      {
        id: 'sc_04', chapter: 2, title: '雾潮之夜', what: '在雾潮之夜登上灯塔，直面真相', points: ['登上灯塔', '真相的一角'], done: '真相揭开', location: loc(1),
        exits: [
          { to: 'sc_05', label: '告诉她真相', when: '两人彼此信任', if: { gte: [aff, 40] } },
          { to: 'sc_06', label: '独自承担', when: '其他情况' },
        ],
        default: 'sc_06',
      },
      { id: 'sc_05', chapter: 2, title: '守望', what: '主角留下，成为新的守灯人', ending: { kind: 'good', text: '两人一起点亮灯塔' } },
      { id: 'sc_06', chapter: 2, title: '离港', what: '主角公开真相后离开雾港', ending: { kind: 'normal', text: '渡船离开时灯塔熄灭' } },
    ],
    threads: [{ text: '日志缺失的最后三页', payoff: '在灯塔顶层找到' }],
  });
}

/** 返回 undefined 表示不是故事相关的请求。 */
export function storyReply(info: MockRequestInfo): string | undefined {
  const system = info.messages.find((m) => m.role === 'system')?.content ?? '';
  const firstUser = info.messages.find((m) => m.role === 'user')?.content ?? '';
  const lastUser = [...info.messages].reverse().find((m) => m.role === 'user')?.content ?? '';

  switch (info.schemaName) {
    case 'world_brief':
      return JSON.stringify({
        title: '雾港谜灯',
        logline: '废弃的灯塔在午夜重新亮起，刚回到故乡雾港的你，发现所有人都在对灯塔的事守口如瓶。',
        genre: '海港悬疑',
        tone: '阴郁中带着温情',
        era: '蒸汽与电灯交替的年代',
        themes: ['归乡', '秘密', '守望'],
        proseStyle: '短句为主，多写声音和气味，对话简洁有留白。',
        artStyle: '水彩质感的日系插画，雾气朦胧，冷色调里点缀昏黄的灯光',
        artNegative: '写实照片感',
        musicStyle: '钢琴和大提琴，慢节奏，带一点海风般的回响',
      });
    case 'world_cast': {
      const n = Number(/加上 (\d+) 个其他角色/.exec(firstUser)?.[1] ?? 3);
      const pName = /名字是「(.+?)」/.exec(firstUser)?.[1] ?? '沈默';
      const npcs = NPC_NAMES.slice(0, n);
      return JSON.stringify({
        characters: [
          {
            name: pName,
            role: 'protagonist',
            gender: '男',
            age: '24',
            summary: '离开雾港多年后回乡的年轻记者',
            appearance: '风衣、旧相机，眼神总在找什么',
            imagePrompt: '黑色短发，深棕色眼睛，瘦高，灰色长风衣，脖子上挂着旧相机',
            traits: ['好奇', '固执'],
            speechStyle: '简短直接',
            background: '十年前父亲在灯塔失踪，此后离开雾港。',
            goals: ['查清灯塔重新亮起的原因'],
            relationships: npcs[0] ? [{ to: npcs[0], type: '青梅竹马', affinity: 40 }] : [],
          },
          ...npcs.map((name, i) => ({
            name,
            role: i === 0 ? 'heroine' : 'npc',
            gender: i % 2 ? '男' : '女',
            age: String(20 + i * 7),
            summary: `${name}，雾港的居民，似乎知道些什么`,
            appearance: '被海风吹得有些凌乱的头发',
            imagePrompt: i === 0 ? '栗色及肩长发，琥珀色眼睛，深蓝色呢子大衣，白色围巾' : `${i % 2 ? '短发' : '马尾'}，灰色眼睛，粗布外套`,
            traits: ['谨慎', '善良'],
            values: ['家人'],
            fears: ['大雾'],
            speechStyle: '说话前总要停顿一下',
            speechExamples: ['……你还是回来了。'],
            background: `${name}一直住在雾港。`,
            goals: ['守住一个秘密'],
            secret: `${name}在灯塔亮起那晚见过一个人影`,
            relationships: [{ to: pName, type: i === 0 ? '青梅竹马' : '旧识', affinity: 20 }],
          })),
        ],
      });
    }
    case 'world_locations':
      return JSON.stringify({
        locations: LOCATIONS.map((l, i) => ({
          ...l,
          connections: [LOCATIONS[(i + 1) % LOCATIONS.length]?.name],
        })),
      });
    case 'world_lore':
      return JSON.stringify({
        entries: [
          { title: '雾潮', category: '规则', content: '每月朔日雾港会被浓雾吞没，持续一整夜，渔船一律不出海。', keys: ['雾潮', '浓雾'], always: true },
          { title: '午夜灯光', category: '事件', content: '废弃十年的灯塔最近三次在午夜亮起，每次都在雾潮之夜。', keys: ['灯塔', '灯光'] },
          { title: '守灯人', category: '历史', content: '灯塔最后一任守灯人十年前失踪，留下一本残缺的日志。', keys: ['守灯人', '日志'] },
        ],
      });
    case 'plot_graph':
      // 观察模式续写新篇章时，系统提示是导演
      return plotGraph(firstUser, system.includes('导演'), info.count);
    case 'bgm_moods': {
      // 本地曲库按文件名挑情绪：第 i 个文件挑情绪表里的第 i 个情绪
      const ids = [...lastUser.matchAll(/^- ([a-z][a-z0-9_]*)（/gm)].map((m) => m[1] as string);
      const files = [...lastUser.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
      return JSON.stringify({ files: files.map((index) => ({ index, mood: ids[index % Math.max(1, ids.length)] ?? '' })) });
    }
    case 'voice_cast': {
      // 分配音色：按性别挑描述里有"女声 / 男声"的，主要角色不重复
      const section = (title: string) => lastUser.split(/^# /m).find((b) => b.startsWith(title)) ?? '';
      const rows = (block: string) => [...block.matchAll(/^- ([^｜\n]+)｜([^\n]*)$/gm)].map((m) => [m[1] as string, m[2] as string] as const);
      const chars = rows(section('要挑音色的角色'));
      const voices = rows(section('音色表'));
      const used = new Set<string>();
      const out = chars.map(([id, rest]) => {
        const female = /｜女/.test(`｜${rest}`);
        const want = female ? '女声' : '男声';
        const v = voices.find(([vid, d]) => d.includes(want) && !used.has(vid)) ?? voices.find(([vid]) => !used.has(vid)) ?? voices[0];
        if (v) used.add(v[0]);
        return { characterId: id, voiceId: v?.[0] ?? '' };
      });
      return JSON.stringify({ voices: out });
    }
    case 'director_plan':
      return directorPlan(lastUser, info.count);
    case 'adv_beat':
      return advBeat(lastUser, info.count);
    case 'adv_detour':
      return advDetour(lastUser);
    case 'story_memory': {
      const names = [...firstUser.slice(0, firstUser.indexOf('# 之前的前情提要')).matchAll(/^- (\S+)/gm)].map((m) => m[1]);
      return JSON.stringify({
        summary: `前情提要：众人围绕灯塔的线索各怀心事。（模拟记忆 #${info.count}）`,
        characters: names.map((name) => ({ name, knows: `${name}记得最近发生的几件事（模拟 #${info.count}）` })),
      });
    }
    case 'story_opening': {
      const loc = /# 地点\n- ([^：\n]+)：/.exec(firstUser)?.[1] ?? LOCATIONS[0]?.name;
      const first = /# 其他角色\n## ([^\s（\n]+)/.exec(firstUser)?.[1] ?? '林夕';
      return JSON.stringify({
        location: loc,
        present: [first],
        narration: '汽笛声穿过薄雾。你拎着旧皮箱走下渡船，码头上的煤气灯一盏接一盏亮起。\n远处，那座废弃十年的灯塔，正一明一暗地闪着光。',
        lines: [{ speaker: first, text: '（站在栈桥尽头）……你还是回来了。灯塔的事，你也看见了吧？' }],
      });
    }
  }

  if (lastUser.includes('世界观正文')) {
    return [
      '## 概况',
      '雾港是一座建在海湾里的旧港口城市，蒸汽机和电灯刚刚开始取代煤油灯。',
      '## 历史',
      '百年前，第一任守灯人在礁石上建起灯塔，从此雾港再没有船只触礁。',
      '## 社会与势力',
      '港务局、渔民行会和走私商人三方维持着脆弱的平衡。',
      '## 规则',
      '每逢雾潮之夜，雾中会传来不属于任何船只的汽笛声。',
      '## 当前局势',
      '废弃十年的灯塔突然在午夜亮起，港务局封锁了消息，渔民行会开始暗中调查。',
    ].join('\n');
  }

  if (system.includes('书记员')) {
    return `前情提要：主角回到雾港，与在场的人谈起了灯塔。（模拟摘要 #${info.count}）`;
  }

  // 观察模式：合并模式的编剧（一次写出整拍）。每拍大约两次请求，按拍数轮换素材
  if (system.includes('演员兼旁白') && system.includes('没有玩家')) {
    const present = namesUnder(system, '在场角色');
    const n = Math.floor(info.count / 2);
    const a = present[n % Math.max(1, present.length)] ?? '林夕';
    const b = present[(n + 1) % Math.max(1, present.length)] ?? a;
    return [
      pick(NARRATION, n),
      `【${a}】（${pick(ACTIONS, n)}）${pick(LINES, n)}`,
      `【${b}】（${pick(ACTIONS, n + 3)}）${pick(LINES, n + 5)}`,
    ].join('\n');
  }

  // 剧情 ADV：演员兼旁白演出玩家的行动和检定结果
  if (system.includes('剧情 ADV（视觉小说）的「演员兼旁白」')) {
    const present = namesUnder(system, '在场角色');
    const a = present[info.count % Math.max(1, present.length)] ?? '林夕';
    const act = /［玩家(?:选择|输入的行动（[^）]*）)：([^］\n]+)］/.exec(lastUser)?.[1];
    const check = /［检定］(.+?)：掷出[^，]*，难度 \d+，([^。]+)。/.exec(lastUser);
    const ending = /［结局］(.+?)：/.exec(lastUser)?.[1];
    return [
      act ? `你决定：${act}。` : pick(NARRATION, info.count),
      check ? `（${check[1]}——${check[2]}）` : '',
      `【${a}】（${pick(ACTIONS, info.count)}）${pick(LINES, info.count)}`,
      ending ? `故事在这里落下帷幕：${ending}。` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // 观察模式：分演模式的旁白和演员
  if (system.startsWith('你是互动故事的旁白')) {
    return pick(NARRATION, Math.floor(info.count / 3));
  }
  const actor = /^你是演员，在一部互动故事里扮演「(.+?)」/.exec(system)?.[1];
  if (actor) {
    return `（${pick(ACTIONS, info.count)}）${pick(LINES, info.count)}`;
  }

  if (system.includes('演员兼旁白')) {
    const present = /# 在场角色\n## ([^\s（\n]+)/.exec(system)?.[1] ?? '林夕';
    const action = /的行动］\n([\s\S]*)$/.exec(lastUser)?.[1]?.trim();
    const variants = ['沉默了一会儿', '轻轻叹了口气', '把目光移向灯塔', '攥紧了衣角'];
    const v = variants[info.count % variants.length];
    if (action) {
      return `海风把你的话吹散了一半。\n【${present}】（${v}）「${action}」……你真的想知道？\n远处又传来一声汽笛。`;
    }
    return `雾越来越浓了。\n【${present}】（${v}）我们不能一直站在这里。`;
  }

  return undefined;
}
