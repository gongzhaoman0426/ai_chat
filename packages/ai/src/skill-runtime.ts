import {
  Workspace,
  type SkillSource,
  type SkillSourceEntry,
  type SkillSourceStat,
} from '@mastra/core/workspace';
import { stringify } from 'yaml';
import { posix } from 'node:path';
import type { PublishedSkill } from '../../agent-config/src/skills';

// A read-only virtual tree preserves native skill/skill_read/skill_search behavior,
// including scripts. It never falls back to the application's real filesystem.
export class SnapshotSkillSource implements SkillSource {
  private files = new Map<string, string>();
  private directories = new Set<string>(['/', '/skills']);
  private owners = new Map<string, string>();
  constructor(
    skills: PublishedSkill[],
    private authorize?: (skillId: string) => Promise<void>,
  ) {
    for (const skill of skills) {
      const root = `/skills/${skill.name}`;
      this.owners.set(root, skill.id);
      const main = `---\n${stringify({ name: skill.name, description: skill.description })}---\n${skill.instructions}`;
      for (const [name, content] of Object.entries({
        'SKILL.md': main,
        ...skill.references,
        ...skill.scripts,
      })) {
        const file = `${root}/${name}`;
        this.files.set(file, content);
        for (let dir = posix.dirname(file); dir !== '/'; dir = posix.dirname(dir))
          this.directories.add(dir);
      }
    }
  }
  private path(path: string) {
    if (path.includes('\\') || path.includes('\0') || path.split('/').includes('..')) return '';
    return posix.resolve('/', path);
  }
  private async check(path: string) {
    for (const [root, id] of this.owners)
      if (
        path === root ||
        path.startsWith(root + '/') ||
        root.startsWith(path === '/' ? '/' : path + '/')
      )
        await this.authorize?.(id);
  }
  async exists(path: string) {
    const key = this.path(path);
    await this.check(key);
    return this.files.has(key) || this.directories.has(key);
  }
  async realpath(path: string) {
    const key = this.path(path);
    await this.check(key);
    if (!key) throw new Error('Invalid skill path');
    return key;
  }
  async stat(path: string): Promise<SkillSourceStat> {
    const key = this.path(path);
    await this.check(key);
    if (!(await this.exists(path))) throw new Error(`Skill file not found: ${path}`);
    return {
      name: posix.basename(key),
      type: this.files.has(key) ? 'file' : 'directory',
      size: Buffer.byteLength(this.files.get(key) ?? ''),
      createdAt: new Date(0),
      modifiedAt: new Date(0),
    };
  }
  async readFile(path: string) {
    const key = this.path(path);
    await this.check(key);
    const content = this.files.get(key);
    if (content === undefined) throw new Error(`Skill file not found: ${path}`);
    return content;
  }
  async readdir(path: string): Promise<SkillSourceEntry[]> {
    const key = this.path(path);
    await this.check(key);
    if (!this.directories.has(key)) return [];
    return [
      ...[...this.directories]
        .filter((dir) => dir !== key && posix.dirname(dir) === key)
        .map((dir) => ({ name: posix.basename(dir), type: 'directory' as const })),
      ...[...this.files.keys()]
        .filter((file) => posix.dirname(file) === key)
        .map((file) => ({ name: posix.basename(file), type: 'file' as const })),
    ];
  }
}
export function skillWorkspace(
  skills: PublishedSkill[],
  authorize?: (skillId: string) => Promise<void>,
) {
  return skills.length
    ? new Workspace({
        skills: skills.map((s) => `/skills/${s.name}`),
        skillSource: new SnapshotSkillSource(skills, authorize),
      })
    : undefined;
}
