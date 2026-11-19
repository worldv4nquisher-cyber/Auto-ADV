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
