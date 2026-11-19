/** 创世管线的步骤（M1 只有文本部分）。顺序即界面上的显示顺序。 */
export const GENESIS_STEPS = [
  { id: 'brief', name: '世界简报', hint: '题材、基调、时代、文风' },
  { id: 'worldview', name: '世界观', hint: '历史、势力、规则、当前局势' },
  { id: 'cast', name: '角色', hint: '主角与其他角色、关系网' },
  { id: 'locations', name: '地点', hint: '故事会发生的地方' },
  { id: 'plot', name: '剧情骨架', hint: '章节、关键节拍、伏笔与结局' },
  { id: 'lore', name: '设定集', hint: '对话中按关键词触发的设定条目' },
  { id: 'opening', name: '开场', hint: '第一个场景，引向第一章' },
] as const;

export type GenesisStepId = (typeof GENESIS_STEPS)[number]['id'];

/** 每一步依赖哪些步骤。 */
export const GENESIS_DEPS: Record<GenesisStepId, GenesisStepId[]> = {
  brief: [],
  worldview: ['brief'],
  cast: ['worldview'],
  locations: ['worldview'],
  plot: ['cast', 'locations'],
  lore: ['cast', 'locations'],
  opening: ['plot'],
};

/** 题材预设。prompt 是交给模型的提示，不会出现在界面上。 */
export const GENESIS_PRESETS = [
  { id: 'random', name: '随机', prompt: '' },
  { id: 'romance', name: '校园恋爱', prompt: '现代校园恋爱，青春、细腻的情感描写，有轻松也有心动和误会' },
  { id: 'fantasy', name: '奇幻冒险', prompt: '剑与魔法的奇幻冒险，有独特的魔法体系、种族与旅途' },
  { id: 'mystery', name: '悬疑推理', prompt: '悬疑推理，封闭环境或连环事件，线索公平、每个人都有秘密' },
  { id: 'horror', name: '克苏鲁', prompt: '克苏鲁式恐怖，不可名状之物、逐渐崩坏的理智、压抑的氛围' },
  { id: 'cyberpunk', name: '赛博朋克', prompt: '赛博朋克，高科技低生活，巨型企业、义体改造、霓虹与雨夜' },
  { id: 'wuxia', name: '武侠修仙', prompt: '东方武侠或修仙，门派、江湖恩怨、功法境界' },
  { id: 'scifi', name: '科幻', prompt: '硬核或太空歌剧式科幻，未来社会、星际航行或人工智能' },
  { id: 'slice', name: '日常治愈', prompt: '温暖的日常治愈，小镇或小店，人与人之间的温情和小烦恼' },
] as const;

export type GenesisPresetId = (typeof GENESIS_PRESETS)[number]['id'];
