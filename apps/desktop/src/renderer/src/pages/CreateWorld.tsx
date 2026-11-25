import type { AssetEstimate, GenesisOptions } from '@auto-adv/engine/api';
import { GENESIS_PRESETS, GENESIS_STEPS, type GenesisPresetId, ROLE_LABELS } from '@auto-adv/schema';
import { useEffect, useState } from 'react';
import { Button, Card, cx, Field, Input, PageHeader, Select, Textarea, useToast } from '../components/ui.tsx';
import { engine, errorMessage } from '../lib/engine.ts';
import { useGenesis } from '../lib/genesis.tsx';
import { useRouter } from '../lib/router.tsx';
import { useSettings } from '../lib/settings.tsx';

export function CreateWorldPage() {
  const { navigate } = useRouter();
  const { settings } = useSettings();
  const genesis = useGenesis();
  const toast = useToast();
  const [seed, setSeed] = useState('');
  const [title, setTitle] = useState('');
  const [preset, setPreset] = useState<GenesisPresetId>('random');
  const [more, setMore] = useState(false);
  const [opts, setOpts] = useState<GenesisOptions>({ characterCount: 3, rating: 'teen' });
  const [busy, setBusy] = useState(false);

  const route = settings?.roles.worldgen ?? settings?.roles.default;
  const routeName = route
    ? `${settings?.endpoints.find((e) => e.id === route.endpointId)?.name ?? '?'} / ${route.model}`
    : null;

  const create = async () => {
    setBusy(true);
    try {
      const worldId = await genesis.create({ seed, title: title.trim() || undefined, preset, options: opts });
      navigate({ page: 'world', worldId });
    } catch (err) {
      toast('err', errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="新建世界"
        subtitle="写一句灵感，或者什么都不写，交给 AI。"
        actions={
          <Button variant="ghost" onClick={() => navigate({ page: 'home' })}>
            返回
          </Button>
        }
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl grid-cols-[1fr_280px] gap-6 px-8 py-8">
          <div className="space-y-5">
            <Field label="灵感（可以留空）">
              <Textarea
                data-testid="seed"
                rows={4}
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="例如：一座只在雨天出现的图书馆，管理员是个不会说谎的少女"
                autoFocus
              />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">题材</span>
              <div className="flex flex-wrap gap-2">
                {GENESIS_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPreset(p.id)}
                    className={cx(
                      'h-8 rounded-lg border px-3 text-sm transition-colors',
                      preset === p.id
                        ? 'border-accent bg-accent-soft text-fg'
                        : 'border-line text-muted hover:border-line-strong hover:text-fg',
                    )}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            <Field label="世界名（可以留空，自动起名）">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="自动起名" />
            </Field>

            <Card>
              <button
                type="button"
                className="flex w-full items-center justify-between px-5 py-3 text-sm text-muted hover:text-fg"
                onClick={() => setMore((m) => !m)}
              >
                <span>更多世界选项</span>
                <span>{more ? '收起' : '展开'}</span>
              </button>
              {more && (
                <div className="grid grid-cols-2 gap-4 border-t border-line px-5 py-5">
                  <Field label="主角名字" hint="你在故事里扮演的角色；留空自动生成">
                    <Input
                      value={opts.protagonistName ?? ''}
                      onChange={(e) => setOpts({ ...opts, protagonistName: e.target.value || undefined })}
                      placeholder="自动生成"
                    />
                  </Field>
                  <Field label="其他角色数量">
                    <Select
                      value={opts.characterCount ?? 3}
                      onChange={(e) => setOpts({ ...opts, characterCount: Number(e.target.value) })}
                    >
                      {[1, 2, 3, 4, 5, 6].map((n) => (
                        <option key={n} value={n}>
                          {n} 个
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="主角设定" className="col-span-2">
                    <Input
                      value={opts.protagonistDescription ?? ''}
                      onChange={(e) => setOpts({ ...opts, protagonistDescription: e.target.value || undefined })}
                      placeholder="例如：刚转学来的高二学生，有一台旧相机"
                    />
                  </Field>
                  <Field label="内容分级">
                    <Select
                      value={opts.rating ?? 'teen'}
                      onChange={(e) => setOpts({ ...opts, rating: e.target.value as GenesisOptions['rating'] })}
                    >
                      <option value="all">全年龄</option>
                      <option value="teen">青少年</option>
                      <option value="mature">成人向</option>
                    </Select>
                  </Field>
                  <div />
                  <Field label="其他要求" className="col-span-2">
                    <Textarea
                      rows={2}
                      value={opts.notes ?? ''}
                      onChange={(e) => setOpts({ ...opts, notes: e.target.value || undefined })}
                      placeholder="例如：不要超自然元素；角色名用日式名字"
                    />
                  </Field>
                </div>
              )}
            </Card>

            <div className="flex items-center gap-3">
              <Button variant="primary" data-testid="create-world" loading={busy} disabled={!route} onClick={create}>
                创建世界
              </Button>
              {!route && <span className="text-xs text-err">还没有给「默认」职责指定模型</span>}
            </div>
          </div>

          <div className="space-y-3">
            <Card className="p-5">
              <div className="text-xs font-medium text-muted">将会生成</div>
              <ol className="mt-3 space-y-2">
                {GENESIS_STEPS.map((s, i) => (
                  <li key={s.id} className="flex gap-2 text-sm">
                    <span className="w-4 text-faint">{i + 1}</span>
                    <span>
                      {s.name}
                      <span className="ml-1.5 text-xs text-faint">{s.hint}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </Card>
            <UsageEstimate characterCount={opts.characterCount ?? 3} />
            {routeName && (
              <p className="px-1 text-xs leading-relaxed text-faint">
                使用模型：{routeName}
                <br />
                （{settings?.roles.worldgen ? ROLE_LABELS.worldgen.name : `${ROLE_LABELS.default.name}职责`}，可在设置 → 职责路由里修改）
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const range = ([a, b]: [number, number], unit: string) => (a === b ? `${a} ${unit}` : `${a}～${b} ${unit}`);
/** 估算的钱：保留两位小数（不到一分的写"不到 ¥0.01"）。 */
const cash = (x: number, currency: string) => {
  const sign = currency === 'CNY' ? '¥' : '$';
  return x > 0 && x < 0.01 ? `不到 ${sign}0.01` : `${sign}${x.toFixed(2)}`;
};
const money = ([a, b]: [number, number], currency: string) => (a === b ? cash(a, currency) : `${cash(a, currency)}～${cash(b, currency)}`);

/**
 * 创世前估算新世界的素材用量（6.5、18.3）：按素材设置和角色数量，给出图片张数、音乐首数、每拍念的字数；
 * 设置里填了单价就折算成钱。估算是可选的，设置里没打开就不显示。
 */
function UsageEstimate({ characterCount }: { characterCount: number }) {
  const { navigate } = useRouter();
  const [est, setEst] = useState<AssetEstimate | null>(null);
  useEffect(() => {
    let live = true;
    engine.call('estimateAssets', { options: { characterCount } }).then(
      (e) => live && setEst(e),
      () => live && setEst(null),
    );
    return () => {
      live = false;
    };
  }, [characterCount]);
  if (!est?.enabled) return null;
  const im = est.images;
  const cost = est.cost;
  return (
    <Card className="p-5" data-testid="usage-estimate">
      <div className="text-xs font-medium text-muted">预计素材用量</div>
      <ul className="mt-3 space-y-2 text-sm">
        {cost?.upfront && (
          <li data-testid="usage-cost">
            开局约 {money(cost.upfront, cost.currency)}
            <div className="text-xs text-faint">按设置里填的单价算{cost.voicePer100Beats ? '，不含语音' : ''}</div>
          </li>
        )}
        {est.imageReady ? (
          <>
            <li data-testid="usage-images">
              开局画 {range(im.upfront, '张')}
              <div className="text-xs text-faint">
                背景 {range(im.backgrounds, '张')}，立绘 {range(im.sprites, '张')}（含表情差分）
              </div>
            </li>
            <li className="text-xs text-faint">
              玩的时候：CG 每个周目 {range(im.cgs, '张')}；时段背景用到才画，最多 {im.timeOfDay[1]} 张
              {cost?.perPlaythrough && `（每个周目约 ${money(cost.perPlaythrough, cost.currency)}）`}
            </li>
            <li className="text-xs text-faint">
              每个世界最多画 {im.cap} 张（算上重抽{cost?.cap !== null && cost?.cap !== undefined ? `，约 ${cash(cost.cap, cost.currency)}` : ''}），可以在设置里改
            </li>
          </>
        ) : (
          <li className="text-xs text-faint">没配图像模型：不画图，舞台上用占位图</li>
        )}
        <li data-testid="usage-music">
          {est.music.tracks ? `音乐：生成 ${est.music.tracks} 首` : '音乐：不生成'}
          {est.music.note && <div className="text-xs text-faint">{est.music.note}</div>}
        </li>
        <li data-testid="usage-voice">
          {est.voice ? `语音：每拍约 ${range(est.voice.perBeat, '字')}` : '语音：不配音'}
          {cost?.voicePer100Beats && <div className="text-xs text-faint">每 100 拍约 {money(cost.voicePer100Beats, cost.currency)}</div>}
        </li>
      </ul>
      <button type="button" className="mt-3 text-xs text-accent-strong hover:underline" onClick={() => navigate({ page: 'settings' })}>
        改素材设置和单价
      </button>
    </Card>
  );
}
