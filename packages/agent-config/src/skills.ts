import { saveResourceScope } from './resource-scope';
import type { StoreScope } from '../../contracts/src/resource-scope';
import { readFile, stat } from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { inflateRawSync } from 'node:zlib';
import { parseDocument, stringify } from 'yaml';
import type { PrismaClient, Tx } from '../../database/src/index';
import { json } from '../../database/src/index';
import {
  skillInputSchema,
  skillReferencePath,
  skillScriptPath,
  type SkillInput,
} from '../../contracts/src/index';
import { assert, hash } from '../../core/src/util';

export type PublishedSkill = Omit<SkillInput, 'scripts'> & {
  scripts?: Record<string, string>;
  id: string;
  revision: number;
  contentHash: string;
};
const MAX_BYTES = 5 * 1024 * 1024;
const decode = (bytes: Buffer) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), 'Skill 仅支持 UTF-8 文本文件');
  return text;
};
function entryText(entry: ReturnType<AdmZip['getEntries']>[number]): string {
  // AdmZip caps inflated output at header.size, except when the declared size is zero.
  if (entry.header.size === 0) {
    const compressed = entry.getCompressedData();
    const empty =
      entry.header.method === 0
        ? compressed
        : entry.header.method === 8
          ? inflateRawSync(compressed, { maxOutputLength: 1 })
          : null;
    assert(empty?.length === 0 && entry.header.crc === 0, 'Skill ZIP 的空文件声明无效');
    return '';
  }
  const data = entry.getData();
  assert(data.length === entry.header.size, 'Skill ZIP 的文件大小声明不匹配');
  return decode(data);
}
function parseMarkdown(text: string): SkillInput {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  assert(match, 'SKILL.md 需要 YAML 头部，包含 name 和 description');
  const document = parseDocument(match[1], { schema: 'core', uniqueKeys: true });
  assert(!document.errors.length && !document.warnings.length, 'SKILL.md 的 YAML 头部无效');
  const metadata = document.toJS({ maxAliasCount: 10 });
  assert(metadata && typeof metadata === 'object' && !Array.isArray(metadata), 'Skill 元信息无效');
  return skillInputSchema.parse({
    name: metadata.name,
    description: metadata.description,
    instructions: match[2],
  });
}
export async function importSkill(file: string): Promise<SkillInput> {
  assert((await stat(file)).size <= MAX_BYTES, 'Skill 文件不能超过 5 MB');
  const bytes = await readFile(file);
  if (/\.md$/i.test(file)) return parseMarkdown(decode(bytes));
  assert(/\.zip$/i.test(file), '请选择 SKILL.md 或 Skill ZIP 包');
  const entries = new AdmZip(bytes).getEntries();
  assert(entries.length <= 200, 'Skill ZIP 目录项过多');
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const path = entry.entryName.replace(/\/$/, '');
    assert(
      path.length <= 320 &&
        !/[\\\x00-\x1f:]/.test(path) &&
        path
          .split('/')
          .every((s) => !!s && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(s)),
      'Skill ZIP 包含非法路径',
    );
    assert(!seen.has(path), 'Skill ZIP 包含重复路径');
    seen.add(path);
    assert(((entry.attr >>> 16) & 0xf000) !== 0xa000, 'Skill ZIP 不支持符号链接');
    total += entry.header.size;
    assert(total <= MAX_BYTES, 'Skill 解压后不能超过 5 MB');
  }
  const files = entries.filter(
    (e) =>
      !e.isDirectory && !e.entryName.split('/').some((p) => p === '__MACOSX' || p === '.DS_Store'),
  );
  assert(files.length <= 100, 'Skill 最多包含 100 个文件');
  const mains = files.filter((e) => /(^|\/)SKILL\.md$/.test(e.entryName));
  assert(mains.length === 1, 'Skill ZIP 必须包含唯一的 SKILL.md');
  const main = mains[0];
  const prefix = main.entryName.slice(0, -'SKILL.md'.length);
  const input = parseMarkdown(entryText(main));
  for (const entry of files) {
    if (entry === main) continue;
    assert(entry.entryName.startsWith(prefix), 'Skill ZIP 中存在技能目录以外的文件');
    const relativePath = entry.entryName.slice(prefix.length);
    const kind = relativePath.startsWith('scripts/') ? 'scripts' : 'references';
    const path = (kind === 'scripts' ? skillScriptPath : skillReferencePath).parse(relativePath);
    input[kind][path] = entryText(entry);
  }
  return skillInputSchema.parse(input);
}
export function exportSkill(input: SkillInput): Buffer {
  const config = skillInputSchema.parse(input);
  const zip = new AdmZip();
  zip.addFile(
    'SKILL.md',
    Buffer.from(
      `---\n${stringify({ name: config.name, description: config.description })}---\n${config.instructions}`,
    ),
  );
  for (const [path, content] of Object.entries({ ...config.references, ...config.scripts }))
    zip.addFile(path, Buffer.from(content));
  return zip.toBuffer();
}

export class SkillService {
  constructor(private db: PrismaClient) {}
  async list() {
    const [skills, agents] = await Promise.all([
      this.db.skillDefinition.findMany({
        where: { status: 'active' },
        orderBy: { updatedAt: 'desc' },
      }),
      this.db.agentDefinition.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, draftConfig: true },
      }),
    ]);
    return skills.map((s) => ({
      ...s,
      ...skillInputSchema.parse({
        name: s.name,
        description: s.description,
        instructions: s.instructions,
        references: s.references,
        scripts: s.scripts,
      }),
      mountedBy: agents
        .filter((a) => ((a.draftConfig as { skillIds?: string[] }).skillIds ?? []).includes(s.id))
        .map(({ id, name }) => ({ id, name })),
    }));
  }
  async save(input: {
    id?: string;
    expectedRevision?: number;
    config: SkillInput;
    storeScope?: StoreScope;
  }) {
    const config = skillInputSchema.parse(input.config);
    return this.db.$transaction(async (tx) => {
      const data = {
        ...config,
        references: json(config.references),
        scripts: json(config.scripts),
      };
      let saved;
      let changed = true;
      if (input.id) {
        const current = await tx.skillDefinition.findFirst({
          where: { id: input.id, status: 'active', revision: input.expectedRevision ?? -1 },
        });
        assert(current, 'Skill 已被修改或删除，请重新加载后保存', 'CONFLICT');
        changed =
          hash(config) !==
          hash(
            skillInputSchema.parse({
              name: current.name,
              description: current.description,
              instructions: current.instructions,
              references: current.references,
              scripts: current.scripts,
            }),
          );
        if (changed) {
          // This counter is only an optimistic-lock token, not a user-facing release.
          const result = await tx.skillDefinition.updateMany({
            where: { id: input.id, status: 'active', revision: input.expectedRevision ?? -1 },
            data: { ...data, revision: { increment: 1 } },
          });
          assert(result.count === 1, 'Skill 已被修改或删除，请重新加载后保存', 'CONFLICT');
          saved = await tx.skillDefinition.findUniqueOrThrow({ where: { id: input.id } });
          if (current.name !== saved.name) {
            const agents = await tx.agentDefinition.findMany({
              where: { status: 'active' },
              select: { revisions: { orderBy: { revision: 'desc' }, take: 1 } },
            });
            const bindings = await tx.agentBinding.findMany();
            const bound = await tx.agentRevision.findMany({
              where: {
                id: { in: bindings.map((binding) => binding.agentRevisionId) },
                agent: { status: 'active' },
              },
            });
            const revisions = new Map(
              [...agents.flatMap((agent) => agent.revisions), ...bound].map((revision) => [
                revision.id,
                revision,
              ]),
            );
            const cache = new Map<string, PublishedSkill | null>();
            for (const revision of revisions.values()) {
              const snapshot = revision.configSnapshot as {
                skillIds?: string[];
                skills?: PublishedSkill[];
              };
              if (snapshot.skillIds?.includes(saved.id)) await currentSkills(tx, snapshot, cache);
            }
          }
        } else saved = current;
      } else saved = await tx.skillDefinition.create({ data });
      if (!input.id && input.storeScope)
        await saveResourceScope(
          tx,
          {
            kind: 'skill',
            resourceId: saved.id,
            expectedRevision: 0,
            ...input.storeScope,
          },
          { invalidateRuns: false },
        );
      if (changed)
        await tx.auditEvent.create({
          data: {
            type: 'skill.save',
            scope: saved.id,
            actor: 'local-user',
            details: { revision: saved.revision },
          },
        });
      const agents = await tx.agentDefinition.findMany({
        where: { status: 'active' },
        select: { id: true, name: true, draftConfig: true },
      });
      return {
        ...saved,
        mountedBy: agents
          .filter((a) =>
            ((a.draftConfig as { skillIds?: string[] }).skillIds ?? []).includes(saved.id),
          )
          .map(({ id, name }) => ({ id, name })),
      };
    });
  }
  async remove(id: string, expectedRevision: number) {
    return this.db.$transaction(async (tx) => {
      const result = await tx.skillDefinition.updateMany({
        where: { id, status: 'active', revision: expectedRevision },
        data: { status: 'deleted', revision: { increment: 1 } },
      });
      assert(result.count === 1, 'Skill 已被修改或删除，请刷新后重试', 'CONFLICT');
      await tx.auditEvent.create({
        data: { type: 'skill.delete', scope: id, actor: 'local-user', details: {} },
      });
      return { ok: true };
    });
  }
  async export(id: string) {
    const skill = await this.db.skillDefinition.findFirst({ where: { id, status: 'active' } });
    assert(skill, 'Skill 不存在');
    return {
      name: skill.name,
      bytes: exportSkill({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        references: skill.references as Record<string, string>,
        scripts: skill.scripts as Record<string, string>,
      }),
    };
  }
}
export async function snapshotSkills(tx: Tx, ids: string[]): Promise<PublishedSkill[]> {
  assert(new Set(ids).size === ids.length, '请勿重复挂载 Skill');
  const rows = await tx.skillDefinition.findMany({ where: { id: { in: ids }, status: 'active' } });
  assert(rows.length === ids.length, '挂载的 Skill 已删除或缺失，请在能力配置中重新选择');
  assert(new Set(rows.map((s) => s.name)).size === rows.length, '同一 Agent 不能挂载同名 Skill');
  return ids.map((id) => {
    const row = rows.find((s) => s.id === id)!;
    const config = skillInputSchema.parse({
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      references: row.references,
      scripts: row.scripts,
    });
    return { ...config, id, revision: row.revision, contentHash: hash(config) };
  });
}

export function publishedSkills(config: {
  skillIds?: string[];
  skills?: PublishedSkill[];
}): PublishedSkill[] {
  const ids = config.skillIds ?? [];
  const skills = config.skills ?? [];
  assert(
    new Set(ids).size === ids.length &&
      skills.length === ids.length &&
      new Set(skills.map((s) => s.id)).size === ids.length &&
      skills.every((s) => ids.includes(s.id)),
    'Agent 的 Skill 快照不完整，请重新发布',
  );
  assert(new Set(skills.map((s) => s.name)).size === skills.length, 'Agent 的 Skill 快照名称重复');
  for (const skill of skills) {
    const input = skillInputSchema.parse({
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      references: skill.references,
      scripts: skill.scripts,
    });
    // Legacy immutable snapshots predate scripts; do not hash new defaults into them.
    const { scripts, ...legacy } = input;
    assert(
      hash(Object.hasOwn(skill, 'scripts') ? input : legacy) === skill.contentHash,
      'Skill 快照校验失败，请重新发布 Agent',
    );
  }
  return skills;
}

// Active skills follow their latest saved content. Keep the published copy only for
// deleted/missing definitions, so existing Agents retain their prior delete behavior.
// A run shares this cache across its entire Agent tree, including lazy sub-Agents.
export async function currentSkills(
  db: PrismaClient | Tx,
  config: { skillIds?: string[]; skills?: PublishedSkill[] },
  cache = new Map<string, PublishedSkill | null>(),
): Promise<PublishedSkill[]> {
  const snapshots = publishedSkills(config);
  const missing = snapshots.filter((skill) => !cache.has(skill.id)).map((skill) => skill.id);
  if (missing.length) {
    const rows = await db.skillDefinition.findMany({
      where: { id: { in: missing }, status: 'active' },
    });
    for (const id of missing) cache.set(id, null);
    for (const row of rows) {
      const input = skillInputSchema.parse({
        name: row.name,
        description: row.description,
        instructions: row.instructions,
        references: row.references,
        scripts: row.scripts,
      });
      cache.set(row.id, {
        ...input,
        id: row.id,
        revision: row.revision,
        contentHash: hash(input),
      });
    }
  }
  // A missing definition can have different preserved content in different Agents.
  // Never put a fallback snapshot in the shared current-content cache.
  const skills = snapshots.map((skill) => cache.get(skill.id) ?? skill);
  assert(
    new Set(skills.map((skill) => skill.name)).size === skills.length,
    '同一 Agent 不能挂载同名 Skill，请修改技能名称',
  );
  return skills;
}
