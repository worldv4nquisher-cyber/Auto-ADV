/**
 * M4 第 6 步：本地生图（ComfyUI，ARCHITECTURE.md 19.7）。用假的 ComfyUI（模拟服务里的 /prompt、/history、/view、/upload/image）测。
 */
import { checkComfy, ComfySettings, comfyUsesModel, comfyWorkflowFor, DEFAULT_COMFY_EDIT, DEFAULT_COMFY_GENERATE } from '@auto-adv/schema';
import { afterEach, describe, expect, it } from 'vitest';
import { ComfyImageClient, decodePng, type ImageExchangeRecord, ProviderError, sniffImage } from '../src/index.ts';
import { encodePng } from '../src/testing/png.ts';
import { type MockServer, type MockServerOptions, startMockServer } from '../src/testing/mock-server.ts';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function mock(opts: MockServerOptions = {}) {
  server = await startMockServer({ chunkDelayMs: 0, ...opts });
  return server;
}

const noSleep = async () => {};
const settings = (o: Partial<ComfySettings> = {}) => ComfySettings.parse(o);
const ref = () => ({ data: new Uint8Array(encodePng(32, 48, () => [200, 120, 90, 255])), mime: 'image/png' });

describe('ComfyUI 的工作流设置', () => {
  it('挑工作流：用途单独写了、是不是改图对得上才用，否则用通用的，再没有用内置的', () => {
    const mine = JSON.stringify({ '1': { class_type: 'LoadImage', inputs: { image: '{{image}}' } }, '2': { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } });
    const s = settings({ purposes: { expression: mine } });
    expect(comfyWorkflowFor(s, 'expression', true)).toEqual({ text: mine, label: '「表情差分」的工作流' });
    // 表情差分单独写的是改图的，文生图时用不上
    expect(JSON.parse(comfyWorkflowFor(s, 'expression', false).text)).toEqual(DEFAULT_COMFY_GENERATE);
    expect(JSON.parse(comfyWorkflowFor(s, 'background', true).text)).toEqual(DEFAULT_COMFY_EDIT);
    expect(comfyWorkflowFor(settings({ generate: ' {"1":{} } ' }), null, false).text).toBe('{"1":{} }');
  });

  it('检查：要是 API 格式、占位符认得、改图的有 {{image}}、都有 {{prompt}}', () => {
    expect(checkComfy(settings())).toBeNull();
    expect(checkComfy(settings({ generate: '{' }))).toMatch(/文生图工作流不是合法的 JSON/);
    expect(checkComfy(settings({ generate: '{"last_node_id": 9, "nodes": []}' }))).toMatch(/不是 API 格式/);
    const node = (inputs: Record<string, unknown>) => JSON.stringify({ '1': { class_type: 'X', inputs } });
    expect(checkComfy(settings({ generate: node({ text: '{{prompt}} {{steps}}' }) }))).toMatch(/\{\{steps\}\} 不认识/);
    expect(checkComfy(settings({ edit: node({ text: '{{prompt}}' }) }))).toMatch(/改图工作流里要有 \{\{image\}\}/);
    expect(checkComfy(settings({ generate: node({ text: '{{prompt}}', image: '{{image}}' }) }))).toMatch(/不能有 \{\{image\}\}/);
    expect(checkComfy(settings({ purposes: { cg: node({ seed: '{{seed}}' }) } }))).toMatch(/「CG」的工作流里没有 \{\{prompt\}\}/);
    // 内置工作流用了 {{model}}；自己写的都不用时模型可以不填
    expect(comfyUsesModel(settings())).toBe(true);
    const noModel = node({ text: '{{prompt}}' });
    expect(comfyUsesModel(settings({ generate: noModel, edit: node({ text: '{{prompt}}', image: '{{image}}' }) }))).toBe(false);
  });
});

describe('ComfyUI 客户端', () => {
  it('文生图：填好内置工作流提交，轮询到画完，从 /view 下载；尺寸、种子是数字', async () => {
    const s = await mock({ comfyPolls: 3 });
    const logs: ImageExchangeRecord[] = [];
    const c = new ComfyImageClient(settings({ negative: '模糊' }), { baseURL: s.comfyURL, sleep: noSleep, onExchange: (r) => logs.push(r) }, 'background');
    const r = await c.generate({ model: 'mock-sdxl.safetensors', prompt: '雨夜的旧书店，暖黄的灯光', size: '1536x1024' });
    expect(sniffImage(r.data)).toBe('image/png');
    expect(decodePng(r.data)).toMatchObject({ width: 96, height: 64 });
    expect(s.comfyRequests).toHaveLength(1);
    expect(s.comfyRequests[0]).toMatchObject({ prompt: '雨夜的旧书店，暖黄的灯光', negative: '模糊', width: 1536, height: 1024, model: 'mock-sdxl.safetensors', image: null });
    expect(typeof s.comfyRequests[0]?.seed).toBe('number');
    expect(String(s.comfyRequests[0]?.clientId)).toMatch(/^auto-adv-/);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ kind: 'image', status: 'ok', request: { workflow: '文生图工作流', size: '1536x1024' } });
  });

  it('改图：参考图先上传，{{image}} 换成上传后的文件名，重绘幅度按设置', async () => {
    const s = await mock();
    const c = new ComfyImageClient(settings({ denoise: 0.4 }), { baseURL: s.comfyURL, sleep: noSleep }, 'expression');
    const r = await c.edit({ model: 'mock-anime.safetensors', prompt: '只改表情：微笑', size: '1024x1536', image: ref() });
    expect(sniffImage(r.data)).toBe('image/png');
    expect(s.comfyUploads).toHaveLength(1);
    expect(s.comfyRequests[0]).toMatchObject({ image: s.comfyUploads[0], denoise: 0.4, width: 1024, height: 1536 });
  });

  it('用途单独写的工作流：按用途挑', async () => {
    const s = await mock();
    const own = JSON.parse(JSON.stringify(DEFAULT_COMFY_GENERATE)) as typeof DEFAULT_COMFY_GENERATE;
    own['2'].inputs.text = '背景专用，{{prompt}}';
    const cfg = settings({ purposes: { background: JSON.stringify(own) } });
    await new ComfyImageClient(cfg, { baseURL: s.comfyURL, sleep: noSleep }, 'background').generate({ model: 'mock-sdxl.safetensors', prompt: '码头' });
    await new ComfyImageClient(cfg, { baseURL: s.comfyURL, sleep: noSleep }, 'cg').generate({ model: 'mock-sdxl.safetensors', prompt: '码头' });
    expect(s.comfyRequests.map((r) => r.prompt)).toEqual(['背景专用，码头', '码头']);
  });

  it('出错：ComfyUI 不接受工作流时说清是哪个节点；跑的时候出错；连不上', async () => {
    const s = await mock();
    const c = new ComfyImageClient(settings(), { baseURL: s.comfyURL, sleep: noSleep });
    await expect(c.generate({ model: 'nope.safetensors', prompt: '码头' })).rejects.toThrow(/不接受这个工作流：Prompt outputs failed validation；节点 1（CheckpointLoaderSimple）：Value not in list，ckpt_name: 'nope.safetensors'/);
    const missing = settings({ generate: JSON.stringify({ ...DEFAULT_COMFY_GENERATE, '8': { class_type: 'UltimateUpscale', inputs: { text: '{{prompt}}' } } }) });
    await expect(new ComfyImageClient(missing, { baseURL: s.comfyURL, sleep: noSleep }).generate({ model: 'mock-sdxl.safetensors', prompt: '码头' })).rejects.toThrow(
      /node UltimateUpscale does not exist/,
    );
    const err = await c.generate({ model: 'mock-sdxl.safetensors', prompt: '任务失败' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).message).toBe('ComfyUI 跑工作流出错（KSampler）：mock: CUDA out of memory');
    const off = new ComfyImageClient(settings(), { baseURL: 'http://127.0.0.1:9', sleep: noSleep });
    const e2 = (await off.generate({ model: 'x', prompt: '码头' }).catch((e: unknown) => e)) as ProviderError;
    expect(e2.message).toMatch(/^连不上 ComfyUI（127\.0\.0\.1:9/);
    expect(e2.retryable).toBe(true);
  });

  it('取消：把排队的任务删掉', async () => {
    const s = await mock({ comfyPolls: 1000 });
    const ctrl = new AbortController();
    const c = new ComfyImageClient(settings(), { baseURL: s.comfyURL, sleep: (_ms, signal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new ProviderError('已取消', { aborted: true })))) });
    const p = c.generate({ model: 'mock-sdxl.safetensors', prompt: '码头' }, ctrl.signal).catch((e: unknown) => e);
    for (let i = 0; i < 100 && !s.comfyRequests.length; i++) await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    expect(((await p) as ProviderError).aborted).toBe(true);
    for (let i = 0; i < 100 && !s.comfyDeleted.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(s.comfyDeleted).toEqual([s.comfyRequests[0]?.promptId]);
  });

  it('模型列表从 /object_info 读', async () => {
    const s = await mock();
    expect(await new ComfyImageClient(settings(), { baseURL: s.comfyURL }).models()).toEqual(['mock-sdxl.safetensors', 'mock-anime.safetensors']);
  });
});
