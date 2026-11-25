import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { AUDIO_EXT, OPENAI_VOICES } from '@auto-adv/providers';
import type { AssetSettings, Character, MediaRoute, VoiceCast, VoiceDef } from '@auto-adv/schema';
import { z } from 'zod';
import type { VoiceCastCharacter, VoiceCastView, VoiceLineParams, VoiceLineResult } from '../api.ts';
import type { AssetService } from '../assets/service.ts';
import type { ModelGateway } from '../llm/gateway.ts';
import { generateJson } from '../llm/structured.ts';
import { writeFileAtomic } from '../util.ts';
import type { WorldData, WorldStore } from '../world/store.ts';

/**
 * 语音（18.8）：每个角色固定一个音色，台词按需生成、按内容缓存。
 *
 * - 配音表存在世界的 assets/voices.json（VoiceCast）。第一次要用的时候分配：文本模型（创世职责）按性别、年龄、性格从音色表里挑，
 *   主要角色之间不重复；没配文本模型或者失败了，按音色描述里的性别挑。换了语音服务（音色 id 对不上）时没锁定的重新分配；
 * - 每一句按（接口、服务地址、模型、音色、情绪、语速、文字）的哈希存成 assets/voice/<哈希>.<扩展名>，
 *   回想里重播、读档之后重放、同一个手写剧本的另一个周目都直接用，不再请求；
 * - 谁说话：旁白、主角默认不配，其他角色配；每个角色还可以在世界里单独关掉。
 */

const CastOut = z.object({
  voices: z
    .array(z.object({ characterId: z.coerce.string(), voiceId: z.coerce.string() }))
    .catch([])
    .default([]),
});

/** 音色表太长时只给文本模型看这么多（中文的优先）。 */
const MAX_CATALOG = 120;

const VOICE_DIR = 'assets/voice';

type Gender = 'f' | 'm' | null;

function genderOfCharacter(c: Character): Gender {
  const g = c.gender.toLowerCase();
  if (/女|female|woman|girl|♀/.test(g)) return 'f';
  if (/男|male|man|boy|♂/.test(g)) return 'm';
  return null;
}

/** 按音色的 id、名字、描述猜性别（先认女声：female 里有 male）。 */
export function genderOfVoice(v: VoiceDef): Gender {
  const t = `${v.id} ${v.name} ${v.description}`.toLowerCase();
  if (/女|female|woman|girl|少女|御姐|萝莉|姐|妈|奶奶|阿姨/.test(t)) return 'f';
  if (/男|male|\bman\b|boy|少年|大叔|爷|叔|哥|父|老头/.test(t)) return 'm';
  return null;
}

const isMain = (c: Character) => c.role !== 'npc';

type AgeBand = 'child' | 'old' | null;

/** 角色的年龄段：12 岁以下算小孩，50 岁以上（或者写了"老"）算老人，其余不管。 */
function ageOfCharacter(c: Character): AgeBand {
  const n = Number(/\d+/.exec(c.age)?.[0] ?? Number.NaN);
  if (/老|elder|old|senior/i.test(c.age) || n >= 50) return 'old';
  if (/童|孩|child|kid/i.test(c.age) || n <= 12) return 'child';
  return null;
}

/** 音色的年龄段（描述里写了才认）。 */
function ageOfVoice(v: VoiceDef): AgeBand {
  const t = `${v.id} ${v.name} ${v.description}`;
  if (/老年|老人|老头|大爷|奶奶|爷爷|婆婆|阿婆|elder|\bold\b|senior|grand/i.test(t)) return 'old';
  if (/童|小孩|萝莉|正太|child|\bkid/i.test(t)) return 'child';
  return null;
}

/** 音色说的语言：id、名字、描述里写了才认（粤语先认，免得 "Chinese (Cantonese)" 认成普通话）。 */
const LANG_WORDS: [string, RegExp][] = [
  ['yue', /cantonese|粤语/i],
  ['zh', /mandarin|chinese|普通话|中文|国语/i],
  ['en', /english|英语|英文/i],
  ['ja', /japanese|日语|日文/i],
  ['ko', /korean|韩语|韩文/i],
  ['es', /spanish|西班牙/i],
  ['pt', /portuguese|葡萄牙/i],
  ['fr', /french|法语/i],
  ['de', /german|德语/i],
  ['ru', /russian|俄语/i],
  ['it', /italian|意大利/i],
  ['ar', /arabic|阿拉伯/i],
  ['tr', /turkish|土耳其/i],
  ['uk', /ukrainian|乌克兰/i],
  ['nl', /dutch|荷兰/i],
  ['vi', /vietnamese|越南/i],
  ['id', /indonesian|印尼/i],
  ['th', /\bthai\b|泰语/i],
  ['hi', /hindi|印地/i],
  ['pl', /polish|波兰/i],
  ['ro', /romanian|罗马尼亚/i],
  ['el', /greek|希腊/i],
  ['cs', /czech|捷克/i],
  ['fi', /finnish|芬兰/i],
  ['sv', /swedish|瑞典/i],
  ['no', /norwegian|挪威/i],
  ['da', /danish|丹麦/i],
  ['hu', /hungarian|匈牙利/i],
  ['he', /hebrew|希伯来/i],
  ['ms', /malay|马来/i],
  ['fil', /filipino|tagalog|菲律宾/i],
  ['fa', /persian|farsi|波斯/i],
  ['bg', /bulgarian|保加利亚/i],
  ['sk', /slovak|斯洛伐克/i],
  ['hr', /croatian|克罗地亚/i],
  ['sr', /serbian|塞尔维亚/i],
  ['sl', /slovenian|斯洛文尼亚/i],
  ['lt', /lithuanian|立陶宛/i],
  ['lv', /latvian|拉脱维亚/i],
  ['et', /estonian|爱沙尼亚/i],
  ['ca', /catalan|加泰罗尼亚/i],
  ['af', /afrikaans|南非/i],
  ['sw', /swahili|斯瓦希里/i],
  ['ta', /tamil|泰米尔/i],
  ['bn', /bengali|孟加拉/i],
  ['ur', /urdu|乌尔都/i],
];
const LANG_NAMES: Record<string, string> = { zh: '中文（普通话）', yue: '粤语', en: '英语', ja: '日语', ko: '韩语' };

export function langOfVoice(v: VoiceDef): string | null {
  const t = `${v.id} ${v.name} ${v.description}`;
  return LANG_WORDS.find(([, re]) => re.test(t))?.[0] ?? null;
}

/** 世界的语言（简报里的 language，默认 zh-CN）：zh-HK、yue 算粤语，其余取前半段。 */
function langOfWorld(w: WorldData): string {
  const l = (w.brief?.language || 'zh-CN').toLowerCase();
  if (/^(yue|zh-hk|zh-mo)/.test(l)) return 'yue';
  return l.split(/[-_]/)[0] || 'zh';
}

/** 自动挑音色时的顺序：和世界语言一样的在前，没写语言的其次，别的语言、方言最后（不打乱原来的顺序）。 */
function byLanguage(voices: VoiceDef[], lang: string): VoiceDef[] {
  const score = (v: VoiceDef) => {
    const l = langOfVoice(v);
    return l === lang ? 0 : l === null ? 1 : 2;
  };
  return voices
    .map((v, i) => ({ v, i, s: score(v) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.v);
}

/** 同一种语言（或没写语言）的音色；一个都没有就全部。 */
function sameLanguage(voices: VoiceDef[], lang: string): VoiceDef[] {
  const local = voices.filter((v) => {
    const l = langOfVoice(v);
    return l === null || l === lang;
  });
  return local.length ? local : voices;
}

/** 旁白挑音色的顺序：写明旁白、有声书的，其次播音、主持，再其次中性的。 */
const NARRATOR_HINTS = [/旁白|叙述|narrat|有声书|audiobook|讲故事|storytell/i, /播音|主持|presenter|anchor|announcer|host/i, /中性|neutral/i];

/** 有没有能念出来的字（只有标点、省略号的不念）。 */
const speakable = (text: string) => (/[\p{L}\p{N}]/u.test(text) ? text.trim() : '');

interface CastState {
  provider: string;
  route: MediaRoute;
  voices: VoiceDef[];
  cast: VoiceCast;
  world: WorldData;
}

export class VoiceService {
  private readonly store: WorldStore;
  private readonly gateway: ModelGateway;
  private readonly assets: AssetService;
  /** 从服务拉取的音色表（MiniMax），按接入点记住。 */
  private readonly catalogs = new Map<string, Promise<VoiceDef[]>>();
  /** 每个世界的配音表（分配好的）。世界或设置改了就丢掉重算。 */
  private readonly states = new Map<string, Promise<CastState | null>>();
  private readonly notes = new Map<string, string | null>();
  private readonly inflight = new Map<string, Promise<VoiceLineResult>>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(store: WorldStore, gateway: ModelGateway, assets: AssetService) {
    this.store = store;
    this.gateway = gateway;
    this.assets = assets;
  }

  /** 世界、设置或者语音职责改了：下次用的时候重新读（没锁定、音色还在的分配不会变）。 */
  invalidate(worldId?: string): void {
    if (worldId) this.states.delete(worldId);
    else {
      this.states.clear();
      this.catalogs.clear();
    }
  }

  /** 语音职责的音色表：设置里写了就用它；OpenAI 用固定的一套；MiniMax 从服务拉取。 */
  async catalog(route: MediaRoute): Promise<VoiceDef[]> {
    if (route.voices?.length) return route.voices;
    if (route.api === 'openai') return OPENAI_VOICES;
    if (route.api !== 'minimax') return [];
    const key = `${route.endpointId}|${route.api}`;
    let p = this.catalogs.get(key);
    if (!p) {
      p = this.gateway.listVoices(route);
      p.catch(() => this.catalogs.delete(key));
      this.catalogs.set(key, p);
    }
    return p;
  }

  // ───────────── 配音表 ─────────────

  private state(worldId: string, recast = false): Promise<CastState | null> {
    let p = recast ? undefined : this.states.get(worldId);
    if (!p) {
      const prev = this.states.get(worldId);
      // 同一个世界的分配一个接一个来（重新分配要等上一次写完）
      p = (prev ?? Promise.resolve(null)).catch(() => null).then(() => this.build(worldId, recast));
      p.catch(() => this.states.delete(worldId));
      this.states.set(worldId, p);
    }
    return p;
  }

  private async build(worldId: string, recast: boolean): Promise<CastState | null> {
    const route = await this.gateway.voiceRoute();
    if (!route) return null;
    const provider = `${route.endpointId}|${route.api}`;
    const [voices, world, saved] = await Promise.all([this.catalog(route), this.store.load(worldId), this.store.readVoiceCast(worldId)]);
    const ids = new Set(voices.map((v) => v.id));
    const next: VoiceCast['characters'] = {};
    for (const c of world.characters) {
      const have = saved.characters[c.id];
      if (have && ids.has(have.voiceId) && (have.locked || (saved.provider === provider && !recast))) next[c.id] = have;
      else if (!recast && c.voice?.voiceId && ids.has(c.voice.voiceId)) next[c.id] = { voiceId: c.voice.voiceId, locked: false };
    }
    const missing = world.characters.filter((c) => !next[c.id]);
    if (missing.length && voices.length) {
      const picked = await this.assign(worldId, langOfWorld(world), world.characters, missing, next, voices);
      for (const [id, voiceId] of picked) next[id] = { voiceId, locked: false };
    }
    let cast = saved;
    if (saved.provider !== provider || JSON.stringify(saved.characters) !== JSON.stringify(next)) {
      cast = { formatVersion: saved.formatVersion, provider, characters: next };
      await this.store.writeVoiceCast(worldId, cast);
    }
    return { provider, route, voices, cast, world };
  }

  /** 给还没有音色的角色分配：先让文本模型挑，挑不了的按性别挑。主要角色之间不重复。 */
  private async assign(
    worldId: string,
    lang: string,
    all: Character[],
    missing: Character[],
    taken: VoiceCast['characters'],
    voices: VoiceDef[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const ids = new Set(voices.map((v) => v.id));
    const mainOf = new Map(all.map((c) => [c.id, isMain(c)]));
    const usedByMain = new Set(
      Object.entries(taken)
        .filter(([id]) => mainOf.get(id))
        .map(([, v]) => v.voiceId),
    );
    const used = new Set(Object.values(taken).map((v) => v.voiceId));
    const accept = (c: Character, voiceId: string) => {
      if (!ids.has(voiceId) || (isMain(c) && usedByMain.has(voiceId))) return false;
      out.set(c.id, voiceId);
      used.add(voiceId);
      if (isMain(c)) usedByMain.add(voiceId);
      return true;
    };
    let note: string | null = null;
    if (await this.gateway.configured('worldgen')) {
      try {
        const picks = await this.askModel(lang, all, missing, taken, voices);
        for (const c of missing) {
          const v = picks.get(c.id);
          if (v) accept(c, v);
        }
      } catch (err) {
        note = `让文本模型分配音色失败（${err instanceof Error ? err.message : String(err)}），按音色描述里的性别挑的`;
      }
    } else {
      note = '没配文本模型，按音色描述里的性别挑的';
    }
    // 剩下的按性别挑（先挑和世界同一种语言的）：先挑没人用的，再挑主要角色没用的，最后随便一个
    const local = sameLanguage(voices, lang);
    for (const c of missing) {
      if (out.has(c.id)) continue;
      const g = genderOfCharacter(c);
      const a = ageOfCharacter(c);
      const fits = local.filter((v) => !g || genderOfVoice(v) === g || genderOfVoice(v) === null);
      // 年龄段对得上的排前面（老人用老年的音色，其他人不用老人、小孩的）
      const aged = fits.filter((v) => ageOfVoice(v) === a);
      const pool = aged.length ? [...aged, ...fits.filter((v) => ageOfVoice(v) !== a)] : fits.length ? fits : voices;
      const free = (v: VoiceDef) => !isMain(c) || !usedByMain.has(v.id);
      const pick = pool.find((v) => !used.has(v.id)) ?? pool.find(free) ?? voices.find(free) ?? voices[0];
      if (pick) {
        out.set(c.id, pick.id);
        used.add(pick.id);
        if (isMain(c)) usedByMain.add(pick.id);
      }
    }
    this.notes.set(worldId, note);
    return out;
  }

  private async askModel(
    lang: string,
    all: Character[],
    missing: Character[],
    taken: VoiceCast['characters'],
    voices: VoiceDef[],
  ): Promise<Map<string, string>> {
    // 音色太多时只给一部分（和世界同一种语言的优先），免得提示词太长
    const shown = byLanguage(voices, lang).slice(0, MAX_CATALOG);
    const line = (c: Character) =>
      [
        c.id,
        c.name,
        c.gender || '性别不明',
        c.age || '年龄不明',
        isMain(c) ? '主要角色' : '配角',
        `性格：${c.personality.traits.join('、') || c.summary.slice(0, 60)}`,
        c.speech.style ? `说话：${c.speech.style.slice(0, 60)}` : '',
      ]
        .filter(Boolean)
        .join('｜');
    const takenLines = Object.entries(taken)
      .map(([id, v]) => {
        const c = all.find((x) => x.id === id);
        return c ? `- ${c.name}：${v.voiceId}` : '';
      })
      .filter(Boolean);
    const h = await this.gateway.forRole('worldgen', 'voice.cast');
    const { value } = await generateJson(this.gateway, h, {
      system:
        `你在给视觉小说的角色挑配音的音色。按角色的性别、年龄、性格和说话方式，从音色表里给每个角色挑一个最合适的音色。主要角色之间不能用同一个音色；配角可以和别人重复，但尽量不和主要角色重复。只能用音色表里的 id。台词是${LANG_NAMES[lang] ?? lang}，音色表里写明是别的语言或方言的不要挑。`,
      user: [
        `# 要挑音色的角色（id｜名字｜性别｜年龄｜类型｜性格｜说话）\n${missing.map((c) => `- ${line(c)}`).join('\n')}`,
        takenLines.length ? `# 已经分好的（不要再给主要角色用这些音色）\n${takenLines.join('\n')}` : '',
        `# 音色表（id｜名字｜描述）\n${shown.map((v) => `- ${v.id}｜${v.name || v.id}｜${v.description}`).join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
      spec: {
        name: 'voice_cast',
        schema: CastOut,
        example: { voices: [{ characterId: '角色 id', voiceId: '音色 id' }] },
      },
      temperature: 0.3,
    });
    return new Map(value.voices.map((v) => [v.characterId.trim(), v.voiceId.trim()]));
  }

  /** 旁白和临时人物的音色：设置里选了就用，没选自动挑一个主要角色没用的。 */
  private extraVoices(st: CastState, settings: AssetSettings): { narrator: string | null; extra: string | null } {
    const ids = new Set(st.voices.map((v) => v.id));
    const main = new Set(
      st.world.characters.filter(isMain).flatMap((c) => {
        const v = st.cast.characters[c.id];
        return v ? [v.voiceId] : [];
      }),
    );
    // 自动挑的时候只挑和世界同一种语言的（中文世界里不会挑到粤语、英语的音色）
    const free = sameLanguage(
      st.voices.filter((v) => !main.has(v.id)),
      langOfWorld(st.world),
    );
    const text = (v: VoiceDef) => `${v.id} ${v.name} ${v.description}`;
    const narrator =
      (ids.has(settings.voice.narratorVoice) ? settings.voice.narratorVoice : null) ??
      NARRATOR_HINTS.map((re) => free.find((v) => re.test(text(v)))).find(Boolean)?.id ??
      free[0]?.id ??
      st.voices[0]?.id ??
      null;
    // 临时人物：先挑谁都没用的（配角用了的也不挑），再挑主要角色没用的
    const used = new Set(Object.values(st.cast.characters).map((v) => v.voiceId));
    const extra =
      (ids.has(settings.voice.extraVoice) ? settings.voice.extraVoice : null) ??
      free.find((v) => v.id !== narrator && !used.has(v.id) && ageOfVoice(v) === null)?.id ??
      free.find((v) => v.id !== narrator)?.id ??
      free[0]?.id ??
      st.voices[0]?.id ??
      null;
    return { narrator, extra };
  }

  /** 这个角色配不配：世界里单独设了就按它，不然主角看设置，其他角色配。 */
  private enabledFor(c: Character, settings: AssetSettings): boolean {
    return settings.characters[c.id]?.voice ?? (c.role === 'protagonist' ? settings.voice.protagonist : true);
  }

  /** 配音表（会先把还没分配的角色分配好）。 */
  async view(worldId: string, recast = false): Promise<VoiceCastView> {
    const settings = await this.assets.effectiveSettings(worldId);
    const route = await this.gateway.voiceRoute();
    let reason: string | null = null;
    let st: CastState | null = null;
    if (!settings.enabled.voice) reason = '语音关着（素材设置里的「语音」开关）';
    else if (!route) reason = '还没有配「语音」职责（设置 → 职责路由）';
    if (!reason) {
      try {
        st = await this.state(worldId, recast);
        if (st && !st.voices.length) reason = '音色表是空的（设置 → 职责路由 → 语音）';
      } catch (err) {
        reason = `读不到音色表：${err instanceof Error ? err.message : String(err)}`;
      }
    }
    const world = st?.world ?? (await this.store.load(worldId));
    const cast = st?.cast ?? (await this.store.readVoiceCast(worldId));
    const names = new Map((st?.voices ?? []).map((v) => [v.id, v.name || v.id]));
    const characters: VoiceCastCharacter[] = world.characters.map((c) => {
      const v = cast.characters[c.id];
      const voiceId = v && (!st || names.has(v.voiceId)) ? v.voiceId : null;
      return {
        id: c.id,
        name: c.name,
        role: c.role,
        voiceId,
        voiceName: voiceId ? (names.get(voiceId) ?? voiceId) : '',
        locked: !!v?.locked,
        enabled: this.enabledFor(c, settings),
      };
    });
    const extra = st ? this.extraVoices(st, settings) : { narrator: null, extra: null };
    return {
      worldId,
      ready: !reason && !!st,
      reason,
      voices: st?.voices ?? [],
      characters,
      narrator: { enabled: settings.voice.narrator, voiceId: extra.narrator },
      extra: { voiceId: extra.extra },
      note: this.notes.get(worldId) ?? null,
    };
  }

  /** 给一个角色换音色（锁定）；voiceId 为 null 解除锁定，重新分配。 */
  async setVoice(worldId: string, characterId: string, voiceId: string | null): Promise<VoiceCastView> {
    const st = await this.state(worldId);
    if (!st) throw new Error('还没有配「语音」职责');
    if (!st.world.characters.some((c) => c.id === characterId)) throw new Error('没有这个角色');
    if (voiceId !== null && !st.voices.some((v) => v.id === voiceId)) throw new Error('音色表里没有这个音色');
    const characters = { ...st.cast.characters };
    if (voiceId === null) delete characters[characterId];
    else characters[characterId] = { voiceId, locked: true };
    await this.store.writeVoiceCast(worldId, { ...st.cast, provider: st.provider, characters });
    this.states.delete(worldId);
    return this.view(worldId);
  }

  // ───────────── 台词 ─────────────

  /** 这一句用哪个音色；不配音为 null。 */
  private voiceFor(st: CastState, settings: AssetSettings, line: VoiceLineParams): string | null {
    if (line.voiceId) return st.voices.some((v) => v.id === line.voiceId) ? line.voiceId : null;
    const extra = this.extraVoices(st, settings);
    const sp = line.speaker;
    if (!sp || line.kind === 'narrate') return settings.voice.narrator ? extra.narrator : null;
    const c = sp.characterId ? st.world.characters.find((x) => x.id === sp.characterId) : undefined;
    if (!c) return extra.extra;
    if (!this.enabledFor(c, settings)) return null;
    return st.cast.characters[c.id]?.voiceId ?? null;
  }

  /** 念一句：有缓存直接返回文件，没有就生成。不配音的（开关、旁白、空台词）返回 null。 */
  async line(worldId: string, line: VoiceLineParams): Promise<VoiceLineResult | null> {
    const settings = await this.assets.effectiveSettings(worldId);
    if (!settings.enabled.voice && !line.voiceId) return null;
    const text = speakable(line.text);
    if (!text) return null;
    const st = await this.state(worldId);
    if (!st || !st.voices.length) return null;
    const voice = this.voiceFor(st, settings, line);
    if (!voice) return null;
    const emotion = settings.voice.emotion && line.expr ? settings.voice.emotions[line.expr] : undefined;
    const speed = settings.voice.speed;
    const key = createHash('sha256')
      .update(JSON.stringify([st.route.api, st.route.endpointId, st.route.model, voice, emotion ?? '', speed, text]))
      .digest('hex')
      .slice(0, 24);
    const cached = await this.findCached(worldId, key);
    if (cached) return { file: cached, durationMs: null };
    const flightKey = `${worldId}|${key}`;
    let p = this.inflight.get(flightKey);
    if (!p) {
      p = this.generate(worldId, key, { text, voice, speed, ...(emotion ? { emotion } : {}) }, settings.voiceConcurrency).finally(() =>
        this.inflight.delete(flightKey),
      );
      this.inflight.set(flightKey, p);
    }
    return p;
  }

  private async findCached(worldId: string, key: string): Promise<string | null> {
    for (const ext of new Set(Object.values(AUDIO_EXT))) {
      const rel = `${VOICE_DIR}/${key}.${ext}`;
      try {
        await fs.access(this.store.assetPath(worldId, rel));
        return rel;
      } catch {
        // 没有这个扩展名的
      }
    }
    return null;
  }

  private async generate(
    worldId: string,
    key: string,
    req: { text: string; voice: string; speed: number; emotion?: string },
    concurrency: number,
  ): Promise<VoiceLineResult> {
    await this.acquire(concurrency);
    try {
      const h = await this.gateway.forVoice('voice.line');
      const r = await h.client.speak({ model: h.model, ...req });
      const rel = `${VOICE_DIR}/${key}.${AUDIO_EXT[r.mime] ?? 'mp3'}`;
      await writeFileAtomic(this.store.assetPath(worldId, rel), r.data);
      return { file: rel, durationMs: r.durationMs };
    } finally {
      this.release();
    }
  }

  /** 同时生成的句数（语音设置里的 voiceConcurrency，所有世界共用）。 */
  private acquire(limit: number): Promise<void> {
    if (this.running < limit) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}
