import { it, expect, afterEach } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { setup } from './helpers';
let f: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await f?.cleanup();
  f = undefined;
});
it('图片 ZIP 导入保留成功行，缺图失败不污染正式问答', async () => {
  f = await setup();
  const zip = new AdmZip();
  zip.addFile('images/a.png', Buffer.from('image-fixture'));
  zip.addFile(
    'manifest.json',
    Buffer.from(
      JSON.stringify([
        { intent: '颜色对照', answerKind: 'image', answer: '', image: 'images/a.png' },
        { intent: '缺图', answerKind: 'image', answer: '', image: 'images/missing.png' },
        { intent: '发货时间', answerKind: 'text', answer: '48 小时内' },
      ]),
    ),
  );
  const path = join(f.dir, 'questions.zip');
  await writeFile(path, zip.toBuffer());
  const preview = await f.engine.knowledge.previewImport(f.account.storeId, path);
  expect(await f.db.knowledgeEntry.count()).toBe(0);
  expect(preview!.rows[1].error).toContain('图片文件缺失');
  const result = await f.engine.knowledge.applyImport(preview!.token, [0, 1, 2]);
  expect(result.filter((r) => 'ok' in r)).toHaveLength(2);
  const image = await f.db.knowledgeRevision.findFirstOrThrow({ where: { answerKind: 'image' } });
  expect(image.attachmentId).toBeTruthy();
  const attachment = await f.db.attachment.findUniqueOrThrow({
    where: { id: image.attachmentId! },
  });
  expect((await readFile(join(f.dir, attachment.relativePath))).toString()).toBe('image-fixture');
  await expect(f.engine.knowledge.applyImport(preview!.token, [0])).rejects.toThrow(
    '导入预览已失效',
  );
});
it('JSON 导入拒绝跨店铺条目与无效内容', async () => {
  f = await setup();
  const path = join(f.dir, 'questions.json');
  await writeFile(
    path,
    JSON.stringify([
      { intent: '错误归属', answerKind: 'text', answer: 'a', storeId: 'foreign' },
      { intent: '', answerKind: 'text', answer: '' },
    ]),
  );
  const preview = await f.engine.knowledge.previewImport(f.account.storeId, path);
  expect(preview!.rows.every((r) => r.error)).toBe(true);
  expect(await f.db.knowledgeEntry.count()).toBe(0);
});
