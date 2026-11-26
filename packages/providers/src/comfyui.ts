import { type ComfySettings, comfyWorkflowFor, parseComfyWorkflow } from '@auto-adv/schema';
import { renderJson, type TemplateVars } from './custom.ts';
import type { ImageEditRequest, ImageExchangeRecord, ImageRequest, ImageResult } from './images.ts';
import { IMAGE_EXT, sniffImage } from './images.ts';
import { describeHttpError, isRetryableStatus, normalizeBaseURL, ProviderError } from './openai-compatible.ts';
import type { FetchLike } from './types.ts';

/**
 * 本地生图（ComfyUI，ARCHITECTURE.md 18.9、19.7）：填好工作流提交到 /prompt，轮询 /history/<id> 等它画完，
 * 再从 /view 下载输出的图片。改图时参考图先用 /upload/image 上传，工作流里的 {{image}} 换成上传后的文件名。
 * 和别的图像接口一样，每次调用只跑一次，重试交给素材队列。
 */

export interface ComfyClientConfig {
  /** ComfyUI 的地址，例如 http://127.0.0.1:8188。 */
  baseURL: string;
  /** 一般不用；ComfyUI 前面套了要密钥的反向代理时用（Authorization: Bearer）。 */
  apiKey?: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** 一张图最多等多久，默认 600 秒（本地显卡第一次加载模型会慢）。 */
  timeoutMs?: number;
  onExchange?: (record: ImageExchangeRecord) => void;
  /** 测试用：轮询的等待。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface HistoryImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface HistoryEntry {
  outputs?: Record<string, { images?: HistoryImage[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] };
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('已取消', { aborted: true }));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ProviderError('已取消', { aborted: true }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function sizeOf(size: string | undefined): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1024, height: 1024 };
}

/** ComfyUI 拒绝工作流时的说明：/prompt 返回 400，error.message 加上每个出错节点的第一条原因。 */
function promptRejection(text: string): string | null {
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string; details?: string };
      node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }>;
    };
    const parts: string[] = [];
    if (j.error?.message) parts.push(j.error.message + (j.error.details ? `（${j.error.details}）` : ''));
    for (const [id, n] of Object.entries(j.node_errors ?? {})) {
      const e = n.errors?.[0];
      if (e) parts.push(`节点 ${id}${n.class_type ? `（${n.class_type}）` : ''}：${e.message ?? ''}${e.details ? `，${e.details}` : ''}`);
    }
    return parts.length ? parts.join('；') : null;
  } catch {
    return null;
  }
}

export class ComfyImageClient {
  readonly baseURL: string;
  private readonly cfg: ComfyClientConfig;
  private readonly settings: ComfySettings;
  private readonly purpose: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly clientId = `auto-adv-${Math.random().toString(36).slice(2, 10)}`;

  /** purpose：这次画的是什么（background、sprite、expression、cg、timeOfDay），用来挑那种用途单独写的工作流。 */
  constructor(settings: ComfySettings, cfg: ComfyClientConfig, purpose: string | null = null) {
    this.settings = settings;
    this.cfg = cfg;
    this.purpose = purpose;
    this.baseURL = normalizeBaseURL(cfg.baseURL);
    this.fetchImpl = cfg.fetch ?? ((url, init) => fetch(url, init));
  }

  generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    return this.run(req, null, signal);
  }

  edit(req: ImageEditRequest, signal?: AbortSignal): Promise<ImageResult> {
    return this.run(req, req.image, signal);
  }

  /** 服务上能用的 checkpoint（CheckpointLoaderSimple 的 ckpt_name 选项）。 */
  async models(signal?: AbortSignal): Promise<string[]> {
    const res = await this.send('/object_info/CheckpointLoaderSimple', { method: 'GET' }, signal);
    const j = (await res.json().catch(() => null)) as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } } } | null;
    const list = j?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    if (!Array.isArray(list)) throw new ProviderError('ComfyUI 没有返回模型列表（CheckpointLoaderSimple 的 ckpt_name）');
    return list.filter((x): x is string => typeof x === 'string');
  }

  private async run(req: ImageRequest, reference: { data: Uint8Array; mime: string } | null, signal?: AbortSignal): Promise<ImageResult> {
    const startedAt = Date.now();
    const { text, label } = comfyWorkflowFor(this.settings, this.purpose, !!reference);
    const { width, height } = sizeOf(req.size);
    const seed = Math.floor(Math.random() * 2_147_483_647);
    const summary: Record<string, unknown> = { workflow: label, model: req.model, prompt: req.prompt, size: `${width}x${height}`, seed };
    let httpStatus: number | null = null;
    const log = (status: ImageExchangeRecord['status'], error: string | null, result?: ImageResult) => {
      try {
        this.cfg.onExchange?.({
          kind: 'image',
          url: `${this.baseURL}/prompt`,
          request: reference ? { ...summary, image: `参考图 ${Math.round(reference.data.length / 1024)} KB` } : summary,
          status,
          httpStatus,
          error,
          revisedPrompt: null,
          bytes: result?.data.length ?? 0,
          startedAt,
          latencyMs: Date.now() - startedAt,
          attempt: 1,
        });
      } catch {
        // 日志出错不影响调用
      }
    };
    const deadline = startedAt + (this.cfg.timeoutMs ?? 600_000);
    let promptId: string | null = null;
    try {
      let workflow: Record<string, unknown>;
      try {
        workflow = parseComfyWorkflow(text, label);
      } catch (err) {
        throw new ProviderError(err instanceof Error ? err.message : String(err));
      }
      const vars: TemplateVars = {
        prompt: req.prompt,
        negative: this.settings.negative,
        width,
        height,
        seed,
        model: req.model,
        denoise: this.settings.denoise,
        image: reference ? await this.upload(reference, signal) : null,
      };
      let filled: unknown;
      try {
        filled = renderJson(workflow, vars);
      } catch (err) {
        throw new ProviderError(`${label}：${err instanceof Error ? err.message : String(err)}`);
      }
      const res = await this.send('/prompt', { method: 'POST', json: { prompt: filled, client_id: this.clientId } }, signal, true);
      httpStatus = res.status;
      const queued = (await res.json().catch(() => ({}))) as { prompt_id?: string };
      if (!queued.prompt_id) throw new ProviderError('ComfyUI 没有返回任务 id（prompt_id）');
      promptId = queued.prompt_id;
      const entry = await this.wait(promptId, deadline, signal);
      const image = Object.values(entry.outputs ?? {})
        .flatMap((o) => o.images ?? [])
        .find((i) => i.filename);
      if (!image) throw new ProviderError('工作流跑完了，但没有输出图片（要有 SaveImage 或 PreviewImage 节点）');
      const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
      const file = await this.send(`/view?${q}`, { method: 'GET' }, signal);
      const data = new Uint8Array(await file.arrayBuffer());
      const mime = sniffImage(data);
      if (!mime) throw new ProviderError('ComfyUI 输出的不是 PNG、JPEG 或 WebP 图片');
      const result: ImageResult = { data, mime, revisedPrompt: null, latencyMs: Date.now() - startedAt };
      log('ok', null, result);
      return result;
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String(err), { cause: err });
      // 取消了：把还在排队的任务删掉，免得白画
      if (pe.aborted && promptId) void this.send('/queue', { method: 'POST', json: { delete: [promptId] } }).catch(() => {});
      log(pe.aborted ? 'aborted' : 'error', pe.message);
      throw pe;
    }
  }

  /** 参考图上传到 ComfyUI 的 input 目录，返回工作流里用的文件名。 */
  private async upload(image: { data: Uint8Array; mime: string }, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    const name = `auto-adv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${IMAGE_EXT[image.mime] ?? 'png'}`;
    form.append('image', new Blob([new Uint8Array(image.data)], { type: image.mime }), name);
    form.append('overwrite', 'true');
    const res = await this.send('/upload/image', { method: 'POST', form }, signal);
    const j = (await res.json().catch(() => ({}))) as { name?: string; subfolder?: string };
    if (!j.name) throw new ProviderError('ComfyUI 没有返回上传后的文件名');
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
  }

  /** 轮询 /history/<id>，直到画完或出错。 */
  private async wait(id: string, deadline: number, signal?: AbortSignal): Promise<HistoryEntry> {
    const sleep = this.cfg.sleep ?? sleepFor;
    for (;;) {
      const res = await this.send(`/history/${encodeURIComponent(id)}`, { method: 'GET' }, signal);
      const j = (await res.json().catch(() => ({}))) as Record<string, HistoryEntry>;
      const entry = j[id];
      if (entry) {
        const st = entry.status;
        if (st?.status_str === 'error') {
          const err = st.messages?.find((m) => m[0] === 'execution_error')?.[1] as { exception_message?: string; node_type?: string } | undefined;
          throw new ProviderError(`ComfyUI 跑工作流出错${err?.node_type ? `（${err.node_type}）` : ''}：${err?.exception_message?.trim() || '没有说明'}`);
        }
        if (st?.completed !== false && entry.outputs && Object.keys(entry.outputs).length) return entry;
      }
      if (Date.now() > deadline) {
        void this.send('/queue', { method: 'POST', json: { delete: [id] } }).catch(() => {});
        throw new ProviderError(`等 ComfyUI 画图超过 ${Math.round((this.cfg.timeoutMs ?? 600_000) / 1000)} 秒`, { retryable: true });
      }
      await sleep(this.settings.pollSeconds * 1000, signal);
    }
  }

  private async send(
    path: string,
    init: { method: string; json?: unknown; form?: FormData },
    signal?: AbortSignal,
    isPrompt = false,
  ): Promise<Response> {
    if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
    const ctrl = new AbortController();
    let timedOut = false;
    // 每个请求本身应该很快；等画图的时间靠轮询，这里给 60 秒
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, 60_000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const url = `${this.baseURL}${path}`;
    try {
      const headers: Record<string, string> = { ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...this.cfg.headers };
      if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method,
          headers,
          body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (signal?.aborted) throw new ProviderError('已取消', { aborted: true });
        if (timedOut) throw new ProviderError(`ComfyUI 60 秒没有响应（${path.split('?')[0]}）`, { retryable: true, cause: err });
        const code = (err as { cause?: { code?: string } }).cause?.code;
        throw new ProviderError(`连不上 ComfyUI（${new URL(url).host}${code ? `，${code}` : ''}），确认它开着、地址对`, { retryable: true, cause: err });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const why = isPrompt ? promptRejection(text) : null;
        throw new ProviderError(why ? `ComfyUI 不接受这个工作流：${why}` : describeHttpError(res.status, text), {
          status: res.status,
          body: text,
          retryable: !why && isRetryableStatus(res.status),
        });
      }
      return res;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
