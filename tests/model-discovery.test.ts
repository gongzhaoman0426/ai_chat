import { afterEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setup } from './helpers';
import { MastraAi } from '../packages/ai/src';
let f: Awaited<ReturnType<typeof setup>>, ai: MastraAi, server: Server;
afterEach(async () => {
  await ai?.close();
  if (server) await new Promise<void>((r) => server.close(() => r()));
  await f?.cleanup();
});

it('从 OpenAI 兼容接口获取模型列表，未填密钥时使用已保存的密钥', async () => {
  f = await setup();
  const auth: Array<string | undefined> = [];
  server = createServer((req, res) => {
    auth.push(req.headers.authorization);
    if (req.url !== '/v1/models') return res.writeHead(404).end();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'm-b' }, { id: 'm-a' }, { id: 'm-b' }, { x: 1 }] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  f.host.secretGet = async () => 'saved-key';
  const saved = await f.db.modelProfile.create({
    data: { name: 'x', kind: 'chat', model: 'm-a', baseUrl, secretRef: 'ref' },
  });
  ai = new MastraAi(f.db, f.dir, f.host);
  await ai.initialize();

  expect(await ai.discoverModels({ baseUrl, apiKey: 'typed-key' })).toEqual(['m-a', 'm-b']);
  expect(await ai.discoverModels({ id: saved.id, baseUrl })).toEqual(['m-a', 'm-b']);
  expect(await ai.discoverModels({ baseUrl })).toEqual(['m-a', 'm-b']);
  expect(auth).toEqual(['Bearer typed-key', 'Bearer saved-key', undefined]);
  await expect(ai.discoverModels({ baseUrl: baseUrl + 'missing' })).rejects.toThrow(
    '模型服务返回 404',
  );
});
