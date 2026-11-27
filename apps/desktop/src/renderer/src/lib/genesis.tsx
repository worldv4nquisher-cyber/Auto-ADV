import type { CreateWorldParams, GenesisChunk, WorldSummary } from '@auto-adv/engine/api';
import type { GenesisStepId, GenesisStepState } from '@auto-adv/schema';
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { useToast } from '../components/ui.tsx';
import { engine, errorMessage, isAborted } from './engine.ts';

/** 一次正在进行的创世（在应用层面保存，切换页面不会中断）。 */
export interface GenesisJob {
  worldId: string;
  steps: Partial<Record<GenesisStepId, GenesisStepState>>;
  /** 每一步已收到的字数。 */
  progress: Partial<Record<GenesisStepId, number>>;
  controller: AbortController;
}

interface GenesisState {
  jobs: Record<string, GenesisJob>;
  /** 每次有世界生成结束（成功或失败）就加一，页面据此刷新。 */
  finished: number;
  /** 开始创世；拿到世界 id 后就返回，生成在后台继续。 */
  create: (p: CreateWorldParams) => Promise<string>;
  /** 续跑；给了 from 从这一步起（含下游）重新生成；给了 steps 只重新生成这几步，note 是附给它们的一句说明。 */
  run: (worldId: string, opts?: { from?: GenesisStepId; steps?: GenesisStepId[]; note?: string }) => void;
  cancel: (worldId: string) => void;
}

const GenesisContext = createContext<GenesisState | null>(null);

export function GenesisProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [jobs, setJobs] = useState<Record<string, GenesisJob>>({});
  const [finished, setFinished] = useState(0);
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  const patch = useCallback((worldId: string, fn: (j: GenesisJob) => GenesisJob) => {
    setJobs((all) => {
      const j = all[worldId];
      return j ? { ...all, [worldId]: fn(j) } : all;
    });
  }, []);

  const onChunk = useCallback(
    (worldId: string, c: GenesisChunk) => {
      if (c.type === 'step') patch(worldId, (j) => ({ ...j, steps: { ...j.steps, [c.step]: c.state } }));
      if (c.type === 'progress') patch(worldId, (j) => ({ ...j, progress: { ...j.progress, [c.step]: c.chars } }));
    },
    [patch],
  );

  const settle = useCallback(
    (worldId: string, p: Promise<WorldSummary>) => {
      p.then(
        (w) => {
          if (w.status === 'ready') toast('ok', `「${w.title}」生成完成`);
          else if (w.status === 'failed') toast('err', `「${w.title}」有步骤生成失败，可以在世界页面重试`);
        },
        (err) => {
          if (!isAborted(err)) toast('err', `创世出错：${errorMessage(err)}`);
        },
      ).finally(() => {
        setJobs((all) => {
          const { [worldId]: _, ...rest } = all;
          return rest;
        });
        setFinished((n) => n + 1);
      });
    },
    [toast],
  );

  const create = useCallback(
    (params: CreateWorldParams) =>
      new Promise<string>((resolve, reject) => {
        const controller = new AbortController();
        let worldId: string | null = null;
        const p = engine.stream(
          'createWorld',
          params,
          (c) => {
            if (c.type === 'world') {
              worldId = c.worldId;
              setJobs((all) => ({ ...all, [c.worldId]: { worldId: c.worldId, steps: {}, progress: {}, controller } }));
              resolve(c.worldId);
              return;
            }
            if (worldId) onChunk(worldId, c);
          },
          controller.signal,
        );
        p.catch((err) => {
          if (!worldId) reject(err);
        });
        p.then(
          () => {},
          () => {},
        ).finally(() => {
          if (worldId) settle(worldId, p);
        });
      }),
    [onChunk, settle],
  );

  const run = useCallback(
    (worldId: string, opts: { from?: GenesisStepId; steps?: GenesisStepId[]; note?: string } = {}) => {
      if (jobsRef.current[worldId]) return;
      const controller = new AbortController();
      setJobs((all) => ({ ...all, [worldId]: { worldId, steps: {}, progress: {}, controller } }));
      settle(worldId, engine.stream('runGenesis', { worldId, ...opts }, (c) => onChunk(worldId, c), controller.signal));
    },
    [onChunk, settle],
  );

  const cancel = useCallback((worldId: string) => jobsRef.current[worldId]?.controller.abort(), []);

  return (
    <GenesisContext.Provider value={{ jobs, finished, create, run, cancel }}>{children}</GenesisContext.Provider>
  );
}

export function useGenesis(): GenesisState {
  const ctx = useContext(GenesisContext);
  if (!ctx) throw new Error('GenesisProvider 缺失');
  return ctx;
}
