import { afterEach, expect, it } from 'vitest';
import { setup } from './helpers';
import { Router } from '../packages/core/src/router';
import { json } from '../packages/database/src/index';
let f: Awaited<ReturnType<typeof setup>>;
afterEach(async () => f?.cleanup());

it('旧工作空间的云端模型设置在启动时清除，并从模型列表隐藏', async () => {
  f = await setup();
  const { db, engine } = f;
  await db.modelProfile.create({
    data: {
      id: 'cloud:chat-1',
      name: '云端对话',
      kind: 'chat',
      model: 'x',
      baseUrl: 'https://cloud.invalid/v1',
    },
  });
  await db.appSetting.update({
    where: { key: 'defaultModelId' },
    data: { value: json('cloud:chat-1') },
  });
  await db.appSetting.create({ data: { key: 'aiSetupMode', value: json('cloud') } });
  await db.appSetting.create({ data: { key: 'embeddingProfileId', value: json('own-embedding') } });

  await engine.initialize();

  const keys = (await db.appSetting.findMany()).map((s) => s.key);
  expect(keys).not.toContain('defaultModelId');
  expect(keys).not.toContain('aiSetupMode');
  expect(keys).toContain('embeddingProfileId');
  const models = (await new Router(engine, {} as any).call('models.list')) as Array<{ id: string }>;
  expect(models.map((m) => m.id)).not.toContain('cloud:chat-1');
  expect(models).toHaveLength(1);
  await expect(
    new Router(engine, {} as any).call('models.save', {
      id: 'cloud:chat-1',
      name: '云端对话',
      kind: 'chat',
      model: 'x',
      baseUrl: 'https://cloud.invalid/v1',
    }),
  ).rejects.toThrow('云端模型已停用');
});
