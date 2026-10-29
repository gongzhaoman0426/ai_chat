import { cancelGeneratingReplies } from './configuration-change';
import { knowledgeWhere } from './knowledge-scope';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import type { PrismaClient, Tx } from '../../database/src/index';
import { json } from '../../database/src/index';
import { qaSchema, type QaInput } from '../../contracts/src/index';
import type { AppHost } from './types';
import { assert, hash, uid, errorText, Mutex } from './util';
const publicationScopeSchema = z.object({ storeId: z.string().min(1).nullable() }).strict();
function approvalHash(
  candidate: {
    storeId: string;
    evaluationId: string;
    sourceRevision: number;
    action: string;
    targetEntryId: string | null;
    expectedActiveRevisionId: string | null;
  },
  qa: unknown,
  publicationScope: unknown,
) {
  return hash({
    qa,
    publicationScope,
    sourceStoreId: candidate.storeId,
    evaluationId: candidate.evaluationId,
    sourceRevision: candidate.sourceRevision,
    action: candidate.action,
    targetEntryId: candidate.targetEntryId,
    expectedActiveRevisionId: candidate.expectedActiveRevisionId,
  });
}
export class KnowledgeService {
  private imports = new Map<
    string,
    {
      storeId: string | null;
      rows: Array<{ index: number; qa?: QaInput; error?: string; conflict?: string }>;
      expires: number;
    }
  >();
  constructor(
    private db: PrismaClient,
    private lock: Mutex,
    private dir: string,
    private host: AppHost,
  ) {}
  async list(
    storeId: string | null,
    search = '',
    scope: 'available' | 'owned' | 'all' = 'available',
  ) {
    return this.db.knowledgeEntry.findMany({
      where: {
        ...(scope === 'all' ? {} : scope === 'owned' ? { storeId } : knowledgeWhere(storeId)),
        status: { in: ['enabled', 'disabled'] },
        ...(search ? { revisions: { some: { intent: { contains: search } } } } : {}),
      },
      include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    });
  }
  async validate(tx: Tx, storeId: string | null, qa: QaInput) {
    if (storeId !== null) {
      const store = await tx.store.findUnique({
        where: { id: storeId },
        select: { id: true, accounts: { select: { id: true }, take: 1 } },
      });
      assert(store, '店铺不存在');
      assert(store.accounts.length, '该店铺已移除，请重新添加账号后维护问答', 'STORE_REMOVED');
    } else assert(qa.scope.productIds.length === 0, '通用问答不能绑定店铺商品，请选择所属店铺');
    if (qa.scope.overridesEntryId) {
      assert(storeId !== null, '只有店铺专属问答可以覆盖通用问答');
      const target = await tx.knowledgeEntry.findUnique({
        where: { id: qa.scope.overridesEntryId },
      });
      assert(
        target?.storeId === null && ['enabled', 'disabled'].includes(target.status),
        '覆盖目标必须是未删除的通用问答，请重新选择',
      );
    }
    if (qa.attachmentId) {
      const a = await tx.attachment.findUnique({ where: { id: qa.attachmentId } });
      assert(a && (a.storeId === storeId || a.storeId === null), '图片不属于当前店铺或通用图片');
      assert(await stat(join(this.dir, a.relativePath)).catch(() => null), '图片文件已丢失');
    }
  }
  async publish(
    tx: Tx,
    storeId: string | null,
    qa: QaInput,
    options: {
      entryId?: string;
      expected?: string | null;
      sourceKind: string;
      approvalId?: string;
      evaluationId?: string;
      turnId?: string;
      sourceRevision?: number;
    },
  ) {
    await this.validate(tx, storeId, qa);
    let entry = options.entryId
      ? await tx.knowledgeEntry.findUnique({
          where: { id: options.entryId },
          include: { revisions: { orderBy: { version: 'desc' }, take: 1 } },
        })
      : null;
    if (options.entryId) {
      assert(entry?.storeId === storeId, '知识不属于当前店铺');
      assert(entry.status !== 'deleted', '问答已删除，不能编辑或恢复', 'KNOWLEDGE_DELETED');
      assert(entry.activeRevisionId === options.expected, '知识版本已变化，请刷新', 'CONFLICT');
    }
    const version = (entry?.revisions[0]?.version ?? 0) + 1;
    if (!entry) {
      const e = await tx.knowledgeEntry.create({ data: { storeId } });
      entry = { ...e, revisions: [] };
    }
    const rev = await tx.knowledgeRevision.create({
      data: {
        entryId: entry.id,
        version,
        intent: qa.intent,
        answerKind: qa.answerKind,
        answer: qa.answer,
        answerBefore: qa.answerKind === 'image' ? (qa.answerBefore ?? '') : '',
        answerAfter: qa.answerKind === 'image' ? (qa.answerAfter ?? '') : '',
        attachmentId: qa.attachmentId,
        scope: json(qa.scope),
        validUntil: qa.validUntil ? new Date(qa.validUntil) : null,
        sourceKind: options.sourceKind,
        approvalId: options.approvalId,
        evaluationId: options.evaluationId,
      },
    });
    await tx.knowledgeEntry.update({
      where: { id: entry.id },
      data: { activeRevisionId: rev.id, status: 'enabled' },
    });
    await tx.knowledgeSource.create({
      data: {
        revisionId: rev.id,
        sourceKind: options.sourceKind,
        turnId: options.turnId,
        sourceRevision: options.sourceRevision,
        rootSourceId: options.turnId ?? rev.id,
      },
    });
    await tx.job.upsert({
      where: { dedupKey: `index:${rev.id}` },
      create: {
        kind: 'index',
        storeId,
        priority: 80,
        dedupKey: `index:${rev.id}`,
        payload: json({ revisionId: rev.id }),
      },
      update: {},
    });
    await tx.auditEvent.create({
      data: {
        type: 'knowledge.publish',
        scope: storeId ?? 'global',
        actor: 'local-user',
        details: json({
          entryId: entry.id,
          revisionId: rev.id,
          sourceKind: options.sourceKind,
          approvalId: options.approvalId,
        }),
      },
    });
    await cancelGeneratingReplies(
      tx,
      storeId === null ? null : [storeId],
      '问答规则已更新，本轮旧回复已取消，请人工处理当前问题',
    );
    await tx.store.updateMany({
      where: storeId === null ? {} : { id: storeId },
      data: { replyConfigEpoch: { increment: 1 } },
    });
    return rev;
  }
  async save(input: {
    storeId: string | null;
    entryId?: string;
    expectedRevisionId?: string | null;
    expectedStoreId?: string | null;
    qa: QaInput;
  }) {
    return this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const qa = qaSchema.parse(input.qa);
        if (input.entryId) {
          const entry = await tx.knowledgeEntry.findUnique({ where: { id: input.entryId } });
          assert(entry, '问答不存在');
          assert(entry.status !== 'deleted', '问答已删除，不能编辑或恢复', 'KNOWLEDGE_DELETED');
          if (entry.storeId !== input.storeId) {
            assert(
              input.expectedStoreId !== undefined && input.expectedStoreId === entry.storeId,
              '知识不属于当前店铺；更改范围需要明确原所属店铺',
            );
            assert(
              entry.activeRevisionId === input.expectedRevisionId,
              '知识版本已变化，请刷新',
              'CONFLICT',
            );
            if (entry.storeId !== null)
              assert(
                await tx.store.findFirst({ where: { id: entry.storeId, accounts: { some: {} } } }),
                '原店铺已移除，请重新添加账号后维护问答',
                'STORE_REMOVED',
              );
            await this.validate(tx, input.storeId, qa);
            await cancelGeneratingReplies(
              tx,
              entry.storeId === null || input.storeId === null
                ? null
                : [entry.storeId, input.storeId],
              '问答范围已更新，本轮旧回复已取消，请人工处理当前问题',
            );
            await tx.knowledgeEntry.update({
              where: { id: entry.id },
              data: { storeId: input.storeId },
            });
            await tx.store.updateMany({
              where:
                entry.storeId === null || input.storeId === null
                  ? {}
                  : { id: { in: [entry.storeId, input.storeId] } },
              data: { replyConfigEpoch: { increment: 1 }, learningConfigEpoch: { increment: 1 } },
            });
            await tx.auditEvent.create({
              data: {
                type: 'knowledge.scope',
                scope: entry.id,
                actor: 'local-user',
                details: json({
                  from: entry.storeId,
                  to: input.storeId,
                  previousRevisionId: entry.activeRevisionId,
                }),
              },
            });
          }
        }
        return this.publish(tx, input.storeId, qa, {
          entryId: input.entryId,
          expected: input.expectedRevisionId,
          sourceKind: 'manual',
        });
      }),
    );
  }
  async setStatus(id: string, status: 'enabled' | 'disabled', expected: string) {
    return this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const e = await tx.knowledgeEntry.findUnique({ where: { id } });
        assert(e && e.status !== 'deleted', '问答已删除或不存在，不能恢复', 'KNOWLEDGE_DELETED');
        assert(e?.activeRevisionId === expected, '知识版本已变化', 'CONFLICT');
        await tx.auditEvent.create({
          data: {
            type: `knowledge.${status}`,
            scope: e.storeId ?? 'global',
            actor: 'local-user',
            details: json({ id, expected }),
          },
        });
        await cancelGeneratingReplies(
          tx,
          e.storeId === null ? null : [e.storeId],
          '问答状态已更新，本轮旧回复已取消，请人工处理当前问题',
        );
        await tx.store.updateMany({
          where: e.storeId === null ? {} : { id: e.storeId },
          data: { replyConfigEpoch: { increment: 1 } },
        });
        return tx.knowledgeEntry.update({ where: { id }, data: { status } });
      }),
    );
  }
  async remove(id: string, expected: string) {
    return this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const entry = await tx.knowledgeEntry.findUnique({ where: { id } });
        assert(entry, '问答不存在');
        assert(entry.activeRevisionId === expected, '知识版本已变化，请刷新后重新确认', 'CONFLICT');
        if (entry.status === 'deleted') return { ok: true };
        // Keep immutable revisions and shared attachments for historical messages,
        // reply evidence and reviews. Deleted is terminal, not a restorable archive.
        await tx.knowledgeEntry.update({ where: { id }, data: { status: 'deleted' } });
        if (entry.status === 'enabled') {
          await cancelGeneratingReplies(
            tx,
            entry.storeId === null ? null : [entry.storeId],
            '问答已删除，本轮旧回复已取消，请人工处理当前问题',
          );
          await tx.store.updateMany({
            where: entry.storeId === null ? {} : { id: entry.storeId },
            data: { replyConfigEpoch: { increment: 1 } },
          });
        }
        const candidates = await tx.knowledgeCandidate.findMany({
          where: { targetEntryId: id, status: { in: ['pending_review', 'approved'] } },
          select: { id: true },
        });
        const candidateIds = candidates.map((c) => c.id);
        if (candidateIds.length) {
          await tx.knowledgeCandidate.updateMany({
            where: { id: { in: candidateIds } },
            data: { status: 'stale' },
          });
          const changes = await tx.knowledgeChange.findMany({
            where: { candidateId: { in: candidateIds }, status: 'pending' },
            select: { id: true },
          });
          if (changes.length) {
            const changeIds = changes.map((c) => c.id);
            await tx.knowledgeChange.updateMany({
              where: { id: { in: changeIds } },
              data: { status: 'conflicted', error: '目标问答已删除，建议不再应用' },
            });
            await tx.job.updateMany({
              where: {
                kind: 'publish',
                dedupKey: { in: changeIds.map((changeId) => `publish:${changeId}`) },
                status: { in: ['pending', 'retry_wait', 'running'] },
              },
              data: {
                status: 'cancelled',
                error: '目标问答已删除，建议不再应用',
                leaseToken: null,
                leaseUntil: null,
              },
            });
          }
        }
        await tx.auditEvent.create({
          data: {
            type: 'knowledge.delete',
            scope: entry.storeId ?? 'global',
            actor: 'local-user',
            details: json({
              id,
              expected,
              previousStatus: entry.status,
              invalidatedCandidates: candidateIds.length,
            }),
          },
        });
        return { ok: true };
      }),
    );
  }
  async review(input: {
    candidateId: string;
    candidateVersion: number;
    contentHash: string;
    requestId: string;
    decision: 'approved' | 'rejected';
    editedQa?: QaInput;
    targetStoreId?: string | null;
    reason?: string;
  }) {
    return this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const repeated = await tx.knowledgeReview.findUnique({
          where: { requestId: input.requestId },
        });
        if (repeated) {
          assert(repeated.candidateId === input.candidateId, '重复操作 ID 与审批不一致');
          if (input.targetStoreId !== undefined) {
            const candidate = await tx.knowledgeCandidate.findUniqueOrThrow({
              where: { id: repeated.candidateId },
            });
            const scope = publicationScopeSchema.safeParse(
              repeated.publicationScope ?? { storeId: candidate.storeId },
            );
            assert(
              scope.success && scope.data.storeId === input.targetStoreId,
              '重复操作 ID 的发布范围与原审批不一致，请刷新后重试',
              'CONFLICT',
            );
          }
          return repeated;
        }
        const c = await tx.knowledgeCandidate.findUnique({
          where: { id: input.candidateId },
          include: { evaluation: { include: { turn: true } } },
        });
        assert(c, '候选不存在');
        assert(
          c.status === 'pending_review' &&
            c.candidateVersion === input.candidateVersion &&
            c.contentHash === input.contentHash,
          '候选已变化或已处理，请刷新',
          'CONFLICT',
        );
        const sourceValid =
          c.evaluation.turn.status === 'answered' &&
          c.evaluation.turn.sourceRevision === c.sourceRevision;
        const target = c.targetEntryId
          ? await tx.knowledgeEntry.findUnique({ where: { id: c.targetEntryId } })
          : null;
        const targetValid =
          !c.targetEntryId ||
          (target?.storeId === c.storeId &&
            target.status !== 'deleted' &&
            target.activeRevisionId === c.expectedActiveRevisionId);
        if (!sourceValid || !targetValid) {
          await tx.knowledgeCandidate.update({ where: { id: c.id }, data: { status: 'stale' } });
          return { status: 'stale', reason: '来源或目标知识已变化，需要重新评估' };
        }
        const qa = input.editedQa ? qaSchema.parse(input.editedQa) : qaSchema.parse(c.content);
        const publicationScope = {
          storeId: input.targetStoreId === undefined ? c.storeId : input.targetStoreId,
        };
        const version =
          c.candidateVersion + (input.editedQa || publicationScope.storeId !== c.storeId ? 1 : 0);
        assert(
          c.action !== 'disable_qa' || publicationScope.storeId === c.storeId,
          '停用建议不能更改适用店铺，请在原店铺停用目标问答',
        );
        const contentHash = approvalHash(c, qa, publicationScope);
        const review = await tx.knowledgeReview.create({
          data: {
            requestId: input.requestId,
            candidateId: c.id,
            candidateVersion: version,
            contentHash,
            publicationScope: json(publicationScope),
            sourceRevision: c.sourceRevision,
            expectedActiveRevisionId: c.expectedActiveRevisionId,
            decision: input.decision,
            reason: input.reason,
          },
        });
        await tx.knowledgeCandidate.update({
          where: { id: c.id },
          data: {
            status: input.decision,
            candidateVersion: version,
            contentHash,
            content: json(qa),
          },
        });
        if (input.decision === 'approved') {
          await this.validate(tx, publicationScope.storeId, qa);
          const change = await tx.knowledgeChange.create({
            data: {
              candidateId: c.id,
              approvalId: review.id,
              applyKey: hash([review.id, version, contentHash]),
            },
          });
          await tx.job.create({
            data: {
              kind: 'publish',
              storeId: publicationScope.storeId,
              dedupKey: `publish:${change.id}`,
              priority: 40,
              payload: json({ changeId: change.id }),
            },
          });
        }
        await tx.auditEvent.create({
          data: {
            type: `knowledge.review.${input.decision}`,
            scope: c.storeId,
            actor: 'local-user',
            details: json({ reviewId: review.id, candidateId: c.id, version, publicationScope }),
          },
        });
        return review;
      }),
    );
  }
  async apply(changeId: string) {
    return this.lock.run(() =>
      this.db.$transaction(async (tx) => {
        const change = await tx.knowledgeChange.findUniqueOrThrow({ where: { id: changeId } });
        if (change.status === 'applied' || change.status === 'conflicted') return;
        const review = await tx.knowledgeReview.findUniqueOrThrow({
          where: { id: change.approvalId },
        });
        const c = await tx.knowledgeCandidate.findUniqueOrThrow({
          where: { id: change.candidateId },
          include: { evaluation: { include: { turn: true } } },
        });
        const target = c.targetEntryId
          ? await tx.knowledgeEntry.findUnique({ where: { id: c.targetEntryId } })
          : null;
        // Older approvals only hashed the QA and always published to the source store.
        const legacy = review.publicationScope === null;
        const publicationScope = publicationScopeSchema.safeParse(
          legacy ? { storeId: c.storeId } : review.publicationScope,
        ).data;
        const valid =
          review.candidateId === c.id &&
          review.decision === 'approved' &&
          c.status === 'approved' &&
          c.candidateVersion === review.candidateVersion &&
          c.contentHash === review.contentHash &&
          (legacy ? hash(c.content) : approvalHash(c, c.content, review.publicationScope)) ===
            review.contentHash &&
          c.sourceRevision === review.sourceRevision &&
          c.expectedActiveRevisionId === review.expectedActiveRevisionId &&
          c.evaluation.turn.sourceRevision === review.sourceRevision &&
          c.evaluation.turn.status === 'answered' &&
          (!c.targetEntryId ||
            (target?.storeId === c.storeId &&
              target.status !== 'deleted' &&
              target.activeRevisionId === review.expectedActiveRevisionId));
        if (
          !valid ||
          !publicationScope ||
          (c.action === 'disable_qa' && publicationScope.storeId !== c.storeId)
        ) {
          await tx.knowledgeChange.update({
            where: { id: change.id },
            data: { status: 'conflicted', error: '批准内容、发布范围、来源或目标版本已变化' },
          });
          await tx.knowledgeCandidate.update({ where: { id: c.id }, data: { status: 'stale' } });
          return;
        }
        let resultRevisionId: string | undefined;
        if (c.action === 'disable_qa') {
          assert(target, '停用目标不存在');
          await this.validate(tx, publicationScope.storeId, qaSchema.parse(c.content));
          await cancelGeneratingReplies(
            tx,
            [c.storeId],
            '问答已按批准建议停用，本轮旧回复已取消，请人工处理当前问题',
          );
          await tx.store.update({
            where: { id: c.storeId },
            data: { replyConfigEpoch: { increment: 1 } },
          });
          await tx.knowledgeEntry.update({
            where: { id: target.id },
            data: { status: 'disabled' },
          });
        } else {
          const r = await this.publish(tx, publicationScope.storeId, qaSchema.parse(c.content), {
            entryId:
              c.action === 'revise_qa' && publicationScope.storeId === c.storeId
                ? (c.targetEntryId ?? undefined)
                : undefined,
            expected: review.expectedActiveRevisionId,
            sourceKind: 'learning',
            approvalId: review.id,
            evaluationId: c.evaluationId,
            turnId: c.evaluation.turnId,
            sourceRevision: c.sourceRevision,
          });
          resultRevisionId = r.id;
        }
        await tx.knowledgeChange.update({
          where: { id: change.id },
          data: { status: 'applied', resultRevisionId },
        });
      }),
    );
  }
  async attach(storeId: string | null, data: Buffer, name: string) {
    if (storeId !== null)
      assert(
        await this.db.store.findFirst({ where: { id: storeId, accounts: { some: {} } } }),
        '该店铺已移除，请重新添加账号',
        'STORE_REMOVED',
      );
    assert(data.length > 0 && data.length <= 8 * 1024 * 1024, '图片需小于 8 MB');
    const image = await this.host.validateImage(data);
    assert(
      image.width * image.height <= 32_000_000 && image.width > 0 && image.height > 0,
      '图片尺寸超限或无法解码',
    );
    assert(
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mime),
      '仅支持 PNG/JPEG/WebP/GIF',
    );
    const extension = (
      {
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'image/gif': 'gif',
      } as Record<string, string>
    )[image.mime];
    const relativePath = `attachments/${uid()}.${extension}`;
    await mkdir(join(this.dir, 'attachments'), { recursive: true });
    await writeFile(join(this.dir, relativePath), data);
    return this.db.attachment.create({
      data: {
        storeId,
        relativePath,
        mimeType: image.mime,
        size: data.length,
        hash: hash(data.toString('base64')),
        name: basename(name),
      },
    });
  }
  async pickImage(storeId: string | null) {
    const file = await this.host.pickFile('image');
    return file ? this.attach(storeId, await readFile(file), basename(file)) : null;
  }
  async pickImages(storeId: string | null) {
    const files = (await this.host.pickFiles('image')).slice(0, 8);
    const rows = [];
    for (const file of files) {
      rows.push(await this.attach(storeId, await readFile(file), basename(file)));
    }
    return rows;
  }
  async previewImport(storeId: string | null, file?: string) {
    const selected = file ?? (await this.host.pickFile('knowledge'));
    if (!selected) return null;
    assert((await stat(selected)).size <= 50 * 1024 * 1024, '导入包需小于 50 MB');
    const bytes = await readFile(selected);
    let rows: unknown;
    let zip: AdmZip | undefined;
    if (selected.toLowerCase().endsWith('.zip')) {
      zip = new AdmZip(bytes);
      let total = 0;
      for (const e of zip.getEntries()) {
        assert(
          !e.entryName.split(/[\\/]/).includes('..') && !/^[\\/]|^[a-zA-Z]:/.test(e.entryName),
          '压缩包包含越界路径',
        );
        total += e.header.size;
        assert(
          e.header.size <= 8 * 1024 * 1024 && total <= 100 * 1024 * 1024,
          '压缩包解压后超出限制',
        );
      }
      const manifest = zip.getEntry('manifest.json');
      assert(manifest, '压缩包缺少 manifest.json');
      rows = JSON.parse(manifest.getData().toString('utf8'));
    } else rows = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(rows) && rows && typeof rows === 'object')
      rows = (rows as { items?: unknown }).items;
    assert(Array.isArray(rows) && rows.length <= 5000, '清单必须是最多 5000 行的 JSON 数组');
    const result: Array<{ index: number; qa?: QaInput; error?: string; conflict?: string }> = [];
    for (const [index, row] of rows.entries()) {
      try {
        assert(row && typeof row === 'object' && !Array.isArray(row), '该行不是对象');
        const data = { ...row } as Record<string, unknown>;
        if ('storeId' in data) {
          assert(data.storeId === storeId, '该行属于其他店铺');
          delete data.storeId;
        }
        if (data.image) {
          assert(zip && typeof data.image === 'string', '图片导入需要 ZIP 中的图片文件');
          const entry = zip.getEntry(data.image);
          assert(entry && !entry.isDirectory, '图片文件缺失');
          data.attachmentId = (await this.attach(storeId, entry.getData(), data.image)).id;
          delete data.image;
        }
        const qa = qaSchema.parse(data);
        await this.validate(this.db, storeId, qa);
        const conflict = await this.db.knowledgeRevision.findFirst({
          where: { intent: qa.intent, entry: { storeId, status: { in: ['enabled', 'disabled'] } } },
        });
        result.push({
          index,
          qa,
          ...(conflict ? { conflict: '已有相同意图，默认跳过；可先编辑原条目' } : {}),
        });
      } catch (e) {
        result.push({ index, error: errorText(e) });
      }
    }
    const token = uid();
    this.imports.set(token, { storeId, rows: result, expires: Date.now() + 30 * 60_000 });
    return { token, rows: result };
  }
  async applyImport(token: string, rows: number[]) {
    const plan = this.imports.get(token);
    assert(plan && plan.expires > Date.now(), '导入预览已失效，请重新选择文件');
    this.imports.delete(token);
    const result = [];
    for (const index of new Set(rows)) {
      const row = plan.rows.find((r) => r.index === index);
      if (!row?.qa || row.error || row.conflict) {
        result.push({ index, error: '无效或冲突行，请先处理' });
        continue;
      }
      try {
        await this.lock.run(() =>
          this.db.$transaction((tx) =>
            this.publish(tx, plan.storeId, row.qa!, { sourceKind: 'import' }),
          ),
        );
        result.push({ index, ok: true });
      } catch (e) {
        result.push({ index, error: errorText(e) });
      }
    }
    return result;
  }
  async export(storeId: string | null, scope: 'available' | 'owned' | 'all' = 'owned') {
    const file = await this.host.saveFile('judesk-knowledge.zip');
    if (!file) return null;
    const entries = await this.list(storeId, '', scope);
    const zip = new AdmZip();
    const rows = [];
    for (const entry of entries) {
      const r = entry.revisions.find((v) => v.id === entry.activeRevisionId);
      if (!r) continue;
      const qa: Record<string, unknown> = {
        intent: r.intent,
        answerKind: r.answerKind,
        answer: r.answer,
        answerBefore: r.answerBefore,
        answerAfter: r.answerAfter,
        scope: r.scope,
        validUntil: r.validUntil?.toISOString() ?? null,
      };
      if (r.attachmentId) {
        const a = await this.db.attachment.findUniqueOrThrow({ where: { id: r.attachmentId } });
        const image = `images/${a.id}.${a.relativePath.split('.').at(-1)}`;
        zip.addFile(image, await readFile(join(this.dir, a.relativePath)));
        qa.image = image;
      }
      rows.push(qa);
    }
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(rows, null, 2)));
    await writeFile(file, zip.toBuffer());
    return { count: rows.length };
  }
}
