import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import { MastraAi } from '../../packages/ai/src/index';
import { mastraFileUrl } from '../../packages/ai/src/libsql-url';
import type { PrismaClient } from '../../packages/database/src/index';
import type { AppHost } from '../../packages/core/src/types';

const [dir, phase] = process.argv.slice(2);
try {
  assert(
    dir && (phase === 'write' || phase === 'read'),
    'Expected data directory and write/read phase',
  );
  // Exercise the production constructors, without any model or network calls.
  const ai = new MastraAi({} as PrismaClient, dir, {} as AppHost);
  await ai.storage.init();
  if (phase === 'write') {
    assert.deepEqual(await ai.vector.listIndexes(), []);
    await ai.vector.createIndex({ indexName: 'qa_smoke', dimension: 3, metric: 'cosine' });
    await ai.vector.upsert({
      indexName: 'qa_smoke',
      ids: ['answer-1'],
      vectors: [[1, 0, 0]],
      metadata: [{ storeId: 'store-a' }],
    });
  } else {
    assert((await ai.vector.listIndexes()).includes('qa_smoke'));
    const matches = await ai.vector.query({
      indexName: 'qa_smoke',
      queryVector: [1, 0, 0],
      topK: 1,
      filter: { storeId: 'store-a' },
    });
    assert.deepEqual(
      matches.map((row) => row.id),
      ['answer-1'],
    );

    const filePath = join(dir, 'db', 'mastra.db');
    const client = createClient({ url: mastraFileUrl(filePath) });
    const databases = await client.execute('PRAGMA database_list');
    const main = databases.rows.find((row) => row.name === 'main');
    assert(main);
    assert.equal(await realpath(String(main.file)), await realpath(filePath));
    client.close();
  }
  await ai.close();
  // libsql statements can retain native handles until GC even after close().
  // Production releases those handles by waiting for the service process to exit.
  process.exit(0);
} catch (error) {
  // Exit also releases partially initialized clients. Preserve the original error
  // rather than replacing it with a subsequent close()/unlink failure.
  console.error(`Mastra storage ${phase} phase failed:`, error);
  process.exit(1);
}
