import { describe, expect, it } from 'vitest';
import { createPortPair, RpcClient, RpcError, serveRpc, type Streaming, type Unary } from '../src/rpc/index.ts';

type TestContract = {
  add: Unary<{ a: number; b: number }, number>;
  hello: Unary<void, string>;
  fail: Unary<void, never>;
  count: Streaming<{ to: number }, number, string>;
  slow: Streaming<void, number, string>;
};

function setup() {
  const [a, b] = createPortPair();
  let slowAborted = false;
  serveRpc<TestContract>(a, {
    add: ({ a, b }) => a + b,
    hello: async () => '你好',
    fail: () => {
      throw Object.assign(new Error('出错了'), { code: 'boom' });
    },
    count: async function* ({ to }) {
      for (let i = 1; i <= to; i++) yield i;
      return 'done';
    },
    slow: async function* (_p, ctx) {
      let i = 0;
      while (!ctx.signal.aborted) {
        yield i++;
        await new Promise((r) => setTimeout(r, 5));
      }
      slowAborted = true;
      throw new Error('aborted');
    },
  });
  return { client: new RpcClient<TestContract>(b), wasSlowAborted: () => slowAborted };
}

describe('RPC', () => {
  it('普通调用', async () => {
    const { client } = setup();
    expect(await client.call('add', { a: 1, b: 2 })).toBe(3);
    expect(await client.call('hello')).toBe('你好');
  });

  it('错误带着 code 传回来', async () => {
    const { client } = setup();
    const err = await client.call('fail').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ message: '出错了', code: 'boom' });
  });

  it('流式调用：先收到所有分片，再拿到返回值', async () => {
    const { client } = setup();
    const chunks: number[] = [];
    const result = await client.stream('count', { to: 3 }, (c) => chunks.push(c));
    expect(chunks).toEqual([1, 2, 3]);
    expect(result).toBe('done');
  });

  it('可以取消进行中的流式调用', async () => {
    const { client, wasSlowAborted } = setup();
    const ctrl = new AbortController();
    const chunks: number[] = [];
    const p = client.stream('slow', undefined, (c) => {
      chunks.push(c);
      if (chunks.length === 3) ctrl.abort();
    }, ctrl.signal);
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(wasSlowAborted()).toBe(true);
  });

  it('断开时未完成的调用报错', async () => {
    const { client } = setup();
    const p = client.stream('slow', undefined, () => {});
    client.close();
    await expect(p).rejects.toMatchObject({ code: 'disconnected' });
  });
});
