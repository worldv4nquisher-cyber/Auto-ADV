/**
 * M4 第 4 步：语音（docs/ARCHITECTURE.md 18.8、19.5）。
 */
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type MockServer, type MockServerOptions, startMockServer } from '@auto-adv/providers/testing';
import { AssetSettings, CUSTOM_API_PRESETS, type MediaRoute, VoiceCast } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { createPortPair, Engine, type EngineContract, MemorySecretStore, RpcClient, serveRpc } from '../src/index.ts';
import { genderOfVoice } from '../src/voice/service.ts';

const EXAMPLES = path.resolve(import.meta.dirname, '../../../examples/worlds');

let dir: string;
let server: MockServer;
let engine: Engine;
let client: RpcClient<EngineContract>;
let endpointId = '';
let worldId = '';
let open = false;

async function teardown() {
  if (!open) return;
  open = false;
  client.close();
  engine.close();
  await server.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}

afterEach(teardown);

/** 导入示例世界（沈默是主角，林夕是女主角，老周是配角），关掉图片；配好语音职责。 */
async function setup(opts: { mock?: MockServerOptions; text?: boolean; voice?: Partial<MediaRoute> | false; assets?: Record<string, unknown> } = {}) {
  await teardown();
  open = true;
  dir = await mkdtemp(path.join(os.tmpdir(), 'auto-adv-voice-'));
  server = await startMockServer({ chunkDelayMs: 0, ...opts.mock });
  engine = new Engine({ dataDir: dir, secrets: new MemorySecretStore(), callLogFile: ':memory:', assetRetryBaseMs: 1 });
  const [a, b] = createPortPair();
  serveRpc(a, engine.handlers());
  client = new RpcClient<EngineContract>(b);
  const ep = await client.call('saveEndpoint', { name: '模拟服务', baseURL: server.baseURL, models: ['mock-chat'], currency: 'CNY', pricing: {} });
  endpointId = ep.id;
  await client.call('saveAssetSettings', {
    settings: AssetSettings.parse({ enabled: { background: false, sprite: false, expression: false, bgm: false }, ...opts.assets }),
  });
  const src = path.join(dir, 'src', 'old_library');
  await cp(path.join(EXAMPLES, 'old_library'), src, { recursive: true });
  worldId = (await client.call('importWorld', { path: src })).id;
  if (opts.text !== false) await client.call('setRole', { role: 'default', route: { endpointId, model: 'mock-chat' } });
  if (opts.voice !== false) await setVoice(opts.voice ?? {});
}

const setVoice = (r: Partial<MediaRoute> = {}) =>
  client.call('setMediaRole', { role: 'voice', route: { endpointId, model: 'mock-speech', api: 'minimax', ...r } });

const say = (characterId: string | null, name: string, text: string, expr?: string) =>
  client.call('voiceLine', { worldId, line: { speaker: { characterId, name }, kind: 'say', text, ...(expr ? { expr } : {}) } });

const voiceOf = (v: Awaited<ReturnType<typeof cast>>, id: string) => v.characters.find((c) => c.id === id)?.voiceId ?? null;
const cast = () => client.call('voiceCast', { worldId });

describe('配音表', () => {
  it('音色按描述猜性别（先认女声）', () => {
    expect(genderOfVoice({ id: 'x', name: '', description: 'female, young' })).toBe('f');
    expect(genderOfVoice({ id: 'male-qn-qingse', name: '青涩青年音色', description: '' })).toBe('m');
    expect(genderOfVoice({ id: 'mock_narrator', name: '旁白', description: '中性' })).toBeNull();
  });

  it('第一次用时分配：文本模型按性别挑，主要角色不重复；主角默认不配；写进 assets/voices.json', async () => {
    await setup();
    const v = await cast();
    expect(v).toMatchObject({ ready: true, reason: null, note: null });
    expect(v.voices.map((x) => x.id)).toContain('mock_girl_bright');
    expect(voiceOf(v, 'char_lin')).toMatch(/^mock_girl_/);
    expect(voiceOf(v, 'char_01')).toMatch(/^mock_(boy|man)_/);
    expect(voiceOf(v, 'char_lin')).not.toBe(voiceOf(v, 'char_01'));
    expect(v.characters.find((c) => c.id === 'char_01')).toMatchObject({ enabled: false, locked: false });
    expect(v.characters.find((c) => c.id === 'char_lin')).toMatchObject({ enabled: true, voiceName: expect.any(String) });
    // 旁白挑描述里有"中性"的
    expect(v.narrator).toEqual({ enabled: false, voiceId: 'mock_narrator' });
    const saved = VoiceCast.parse(JSON.parse(await readFile(path.join(dir, 'worlds', worldId, 'assets', 'voices.json'), 'utf8')));
    expect(saved.provider).toBe(`${endpointId}|minimax`);
    expect(Object.keys(saved.characters).sort()).toEqual(['char_01', 'char_lin', 'char_zhou']);
    // 再问一次不会重新分配
    const calls = (await client.call('listCalls', { limit: 100 })).items.filter((c) => c.tag === 'voice.cast');
    expect(calls).toHaveLength(1);
    await cast();
    expect((await client.call('listCalls', { limit: 100 })).items.filter((c) => c.tag === 'voice.cast')).toHaveLength(1);
  });

  it('没配文本模型：按音色描述里的性别挑，并说明', async () => {
    await setup({ text: false });
    const v = await cast();
    expect(v.note).toMatch(/没配文本模型/);
    expect(voiceOf(v, 'char_lin')).toMatch(/^mock_girl_/);
    expect(voiceOf(v, 'char_01')).toMatch(/^mock_(boy|man)_/);
    expect(voiceOf(v, 'char_zhou')).toMatch(/^mock_(boy|man|elder)/);
  });

  it('按规则挑音色：只挑和世界同一种语言的，按年龄段挑；旁白先挑有声书、播音一类的', async () => {
    await setup({
      text: false,
      assets: { voice: { narrator: true } },
      voice: {
        voices: [
          { id: 'English_Lady', name: 'Graceful Lady', description: 'female, English' },
          { id: 'Cantonese_Host', name: '专业女主持', description: '一位中性、专业的粤语主持人声音' },
          { id: 'girl', name: '少女', description: '女声' },
          { id: 'boy', name: '少年', description: '男声' },
          { id: 'elder', name: '大爷', description: '男声，老年' },
          { id: 'Chinese (Mandarin)_Audiobook', name: '有声书', description: '男声，普通话' },
        ],
      },
    });
    const v = await cast();
    expect(voiceOf(v, 'char_lin')).toBe('girl');
    // 老周六十多岁：用老年的音色
    expect(voiceOf(v, 'char_zhou')).toBe('elder');
    expect(v.narrator).toEqual({ enabled: true, voiceId: 'Chinese (Mandarin)_Audiobook' });
    expect(v.extra.voiceId).not.toMatch(/English|Cantonese/);
  });

  it('自己选的音色锁定，重新分配不动它；换了语音服务，音色对不上的重新分配', async () => {
    await setup();
    let v = await client.call('setCharacterVoice', { worldId, characterId: 'char_zhou', voiceId: 'mock_elder' });
    expect(v.characters.find((c) => c.id === 'char_zhou')).toMatchObject({ voiceId: 'mock_elder', locked: true });
    await expect(client.call('setCharacterVoice', { worldId, characterId: 'char_zhou', voiceId: 'nope' })).rejects.toThrow('音色表里没有');
    v = await client.call('recastVoices', { worldId });
    expect(voiceOf(v, 'char_zhou')).toBe('mock_elder');
    // 换成 OpenAI 风格：固定的一套音色，老周锁定的音色不在里面，也重新分配
    await setVoice({ api: 'openai' });
    v = await cast();
    expect(v.voices.map((x) => x.id)).toContain('nova');
    expect(['coral', 'nova', 'sage', 'shimmer']).toContain(voiceOf(v, 'char_lin'));
    expect(v.characters.find((c) => c.id === 'char_zhou')).toMatchObject({ locked: false });
    // 解除锁定
    await setVoice();
    await client.call('setCharacterVoice', { worldId, characterId: 'char_lin', voiceId: 'mock_girl_calm' });
    v = await client.call('setCharacterVoice', { worldId, characterId: 'char_lin', voiceId: null });
    expect(v.characters.find((c) => c.id === 'char_lin')).toMatchObject({ locked: false, voiceId: expect.stringMatching(/^mock_girl_/) });
  });

  it('语音关着、没配语音职责、音色表是空的：不能配音，说明原因', async () => {
    await setup({ voice: false });
    expect((await cast()).reason).toMatch(/还没有配「语音」职责/);
    expect(await say('char_lin', '林夕', '你好')).toBeNull();
    await setVoice({ api: 'custom', custom: CUSTOM_API_PRESETS.voice[0]?.api, voices: [] });
    expect((await cast()).reason).toMatch(/音色表是空的/);
    await setVoice();
    await client.call('saveWorldAssetSettings', { worldId, patch: { enabled: { voice: false } } });
    expect((await cast()).reason).toMatch(/语音关着/);
    expect(await say('char_lin', '林夕', '你好')).toBeNull();
    expect(server.speechRequests).toHaveLength(0);
  });
});

describe('台词', () => {
  it('念一句：存进 assets/voice，表情换成情绪；同一句再要直接用缓存', async () => {
    await setup();
    const r = await say('char_lin', '林夕', '你也是来找那本书的吗？', 'smile');
    expect(r?.file).toMatch(/^assets\/voice\/[0-9a-f]{24}\.wav$/);
    expect(r?.durationMs).toBe(11 * 60);
    expect(existsSync(path.join(dir, 'worlds', worldId, r?.file ?? ''))).toBe(true);
    const lin = voiceOf(await cast(), 'char_lin');
    expect(server.speechRequests[0]).toMatchObject({
      api: 'minimax',
      model: 'mock-speech',
      text: '你也是来找那本书的吗？',
      voice_setting: { voice_id: lin, speed: 1, emotion: 'happy' },
      output_format: 'hex',
    });
    const again = await say('char_lin', '林夕', '你也是来找那本书的吗？', 'smile');
    expect(again?.file).toBe(r?.file);
    expect(server.speechRequests).toHaveLength(1);
    // 表情不同就是另一句
    await say('char_lin', '林夕', '你也是来找那本书的吗？', 'sad');
    expect(server.speechRequests).toHaveLength(2);
    expect(server.speechRequests[1]).toMatchObject({ voice_setting: { emotion: 'sad' } });
    // 同时要同一句只请求一次
    await Promise.all([say('char_lin', '林夕', '一起去吧。'), say('char_lin', '林夕', '一起去吧。')]);
    expect(server.speechRequests).toHaveLength(3);
    const calls = (await client.call('listCalls', { limit: 100 })).items.filter((c) => c.role === 'voice');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ tag: 'voice.line', kind: 'voice', status: 'ok' });
  });

  it('谁说话：主角、旁白默认不配；临时人物用通用音色；单独关掉的角色不配；只有标点的不念', async () => {
    await setup();
    expect(await say('char_01', '沈默', '我只是来还书的。')).toBeNull();
    expect(await client.call('voiceLine', { worldId, line: { speaker: null, kind: 'narrate', text: '雨停了。' } })).toBeNull();
    expect(await say('char_lin', '林夕', '……')).toBeNull();
    expect(server.speechRequests).toHaveLength(0);
    const v = await cast();
    await say(null, '路人', '借过一下。');
    expect(server.speechRequests[0]).toMatchObject({ voice_setting: { voice_id: v.extra.voiceId } });
    expect(v.extra.voiceId).not.toBe(voiceOf(v, 'char_lin'));
    // 打开主角和旁白，关掉老周
    await client.call('saveWorldAssetSettings', {
      worldId,
      patch: { voice: { protagonist: true, narrator: true }, characters: { char_zhou: { voice: false } } },
    });
    expect(await say('char_01', '沈默', '我只是来还书的。')).not.toBeNull();
    expect(await client.call('voiceLine', { worldId, line: { speaker: null, kind: 'narrate', text: '雨停了。' } })).not.toBeNull();
    expect(server.speechRequests.at(-1)).toMatchObject({ voice_setting: { voice_id: 'mock_narrator' } });
    expect(await say('char_zhou', '老周', '天要黑了。')).toBeNull();
    const after = await cast();
    expect(after.characters.find((c) => c.id === 'char_zhou')?.enabled).toBe(false);
    expect(after.narrator.enabled).toBe(true);
  });

  it('语速和情绪开关进设置；模型不认情绪时去掉再发', async () => {
    await setup({ mock: { speechNoEmotion: true }, assets: { voice: { speed: 1.2, emotions: { smile: 'happy' } } } });
    const r = await say('char_lin', '林夕', '太好了！', 'smile');
    expect(r).not.toBeNull();
    expect(server.speechRequests).toHaveLength(2);
    expect(server.speechRequests[0]).toMatchObject({ voice_setting: { speed: 1.2, emotion: 'happy' } });
    expect(server.speechRequests[1]?.voice_setting).not.toHaveProperty('emotion');
    await client.call('saveWorldAssetSettings', { worldId, patch: { voice: { emotion: false } } });
    await say('char_lin', '林夕', '再说一句。', 'smile');
    expect(server.speechRequests.at(-1)?.voice_setting).not.toHaveProperty('emotion');
  });

  it('试听：给了音色就用它（语音关着也能听）', async () => {
    await setup();
    await client.call('saveWorldAssetSettings', { worldId, patch: { enabled: { voice: false } } });
    const r = await client.call('voiceLine', { worldId, line: { speaker: { characterId: 'char_lin', name: '林夕' }, kind: 'say', text: '试听一下。', voiceId: 'mock_girl_calm' } });
    expect(r).not.toBeNull();
    expect(server.speechRequests[0]).toMatchObject({ voice_setting: { voice_id: 'mock_girl_calm' } });
  });

  it('OpenAI 风格和自定义接口', async () => {
    await setup({ voice: { api: 'openai' } });
    const lin = voiceOf(await cast(), 'char_lin');
    expect(await say('char_lin', '林夕', '你好。', 'smile')).not.toBeNull();
    expect(server.speechRequests[0]).toEqual({ api: 'openai', model: 'mock-speech', input: '你好。', voice: lin, response_format: 'mp3' });

    const custom = CUSTOM_API_PRESETS.voice.find((p) => p.id === 'openai')?.api;
    await setVoice({ api: 'custom', custom, voices: [{ id: 'v1', name: '女声一', description: '女声' }, { id: 'v2', name: '男声一', description: '男声' }] });
    const v = await cast();
    expect(voiceOf(v, 'char_lin')).toBe('v1');
    await say('char_lin', '林夕', '换成自定义接口了。');
    expect(server.speechRequests.at(-1)).toEqual({ api: 'openai', model: 'mock-speech', input: '换成自定义接口了。', voice: 'v1', speed: 1, response_format: 'mp3' });
  });
});

describe('设置页', () => {
  it('拉取音色、念一句试试；音色表不能有重复 id', async () => {
    await setup({ voice: false });
    const route = { endpointId, model: 'mock-speech', api: 'minimax' as const };
    const voices = await client.call('fetchVoices', { route });
    expect(voices).toHaveLength(6);
    expect(voices[0]).toEqual({ id: 'mock_girl_bright', name: '明亮少女', description: '女声，少女，明亮活泼' });
    expect(await client.call('fetchVoices', { route: { ...route, api: 'openai' } })).toContainEqual(expect.objectContaining({ id: 'nova' }));
    await expect(client.call('fetchVoices', { route: { ...route, api: 'custom', custom: CUSTOM_API_PRESETS.voice[0]?.api } })).rejects.toThrow('自己写音色表');
    const r = await client.call('testVoice', { route });
    expect(r.dataUrl).toMatch(/^data:audio\/wav;base64,/);
    expect(server.speechRequests[0]).toMatchObject({ voice_setting: { voice_id: 'mock_girl_bright' } });
    await client.call('testVoice', { route, voice: 'mock_elder', text: '老人家说一句。' });
    expect(server.speechRequests[1]).toMatchObject({ text: '老人家说一句。', voice_setting: { voice_id: 'mock_elder' } });
    await expect(setVoice({ voices: [{ id: 'a', name: '', description: '' }, { id: 'a', name: '', description: '' }] })).rejects.toThrow('重复的音色 id');
    await expect(setVoice({ model: '' })).rejects.toThrow('请填写语音模型');
  });
});
