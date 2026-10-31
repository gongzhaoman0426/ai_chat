# Skills 技能库

JuDesk 的高级能力分为四类，分别配置、分别挂载给回复 Agent：

| 类型 | 用途 | 管理入口 |
| --- | --- | --- |
| Skill | 描述某个场景的处理方法，包含 Markdown 步骤、参考资料和可执行脚本 | Skills |
| Toolkit | 通过成员契约、设置项和平台能力适配提供可执行工具集合 | Toolkit |
| 子 Agent | 将任务交给独立配置的专业助手 | Agent Studio 的子 Agent 挂载区 |

系统设置打开开发者模式后，侧栏显示助手、Skills、扩展（Toolkit）和 Agent 执行。关闭开发者模式只隐藏这些入口，已配置的工作 Agent 继续运行。单机用户不需要组织、成员或团队空间。

## 创建与使用

1. 在 **Skills → 新建 Skill** 填写小写英文名称和适用场景。适用场景应说明“什么情况下需要这个技能”，帮助 Agent 决定是否加载。
2. 左侧选择 `SKILL.md` 编辑处理步骤；业务规则和案例放入 `references/`，需要计算或处理数据时在 `scripts/` 添加脚本。
3. 选中脚本，点击 **试运行**，填写 JSON 字符串数组参数、可选标准输入和超时时间，再点击 **运行脚本**。这会运行当前未保存草稿，不调用模型，不保存 Skill，也不改变工作绑定。运行中可以停止，结束后显示 stdout、stderr、状态、退出码和耗时。修改代码或参数后，界面会标记上次结果已过期。
4. 保存到本机后，在 **Agent Studio → 能力配置 → Skills → 添加 Skill** 搜索并挂载。也可以直接点击“新建并挂载技能”。点击已挂载的技能可以继续编辑。
5. 在 Agent Studio 输入买家消息并试运行，验证 Agent 能否正确选择技能与调用脚本。这里使用所选模型和隔离的会话存储，平台发送工具不发送真实消息；脚本的文件写入或网络请求仍会实际执行。
6. 发布 Agent。已绑定该 Agent 的接待自动使用最新版；首次选用或改绑其他 Agent 仍在工作绑定中确认。

Skill 用于处理方法和配套代码；问答库仍保存可审批、可追溯的业务问答。Skill 不会自动变成问答对，也不会替代自动学习的人工审批。内置学习 Agent 不挂载用户 Skill、Toolkit 或子 Agent，也没有 `runSkillScript`。

## 编辑器与文件格式

编辑器顶部填写技能名称和适用场景，左侧分别管理参考资料与脚本，右侧编辑选中的文件。`SKILL.md` 编辑区只写正文，导出时自动生成包含 name / description 的 YAML 文件头。两类文件都可创建嵌套目录。

```text
SKILL.md
references/
  policy.md
  after-sales/
    refund.md
scripts/
  calculate.ts
  helpers/
    numbers.ts
```

名称使用小写字母、数字和单个连字符，最长 64 字符；场景说明最长 1024 字符；正文和每个文件最长 200000 字符；参考资料与脚本合计最多 99 个文件，内容总计最多 5 MB。路径不可包含 `..`、空目录、反斜线、控制字符、冒号或特殊原型键，也不允许文件与目录前缀冲突。

修改已有技能采用 revision 乐观锁，冲突时保留编辑内容，防止静默覆盖。关闭时有未保存修改会提示继续编辑或放弃修改。试运行期间暂停修改与关闭，仍可点击停止。

## 脚本示例

下面的示例只演示参数和输出。业务数据应来自已核实的资料或查询结果。

```markdown
---
name: price-calculation
description: 已取得原价和折扣比例，需要准确计算折后金额时使用。
---
# 折后金额计算

1. 核实原价与折扣比例，不猜测缺失的数值。
2. 调用 runSkillScript：skillName 为 price-calculation，path 为 scripts/calculate.ts。
3. args 传入两个字符串：[原价, 折扣比例]，例如 ["100", "0.9"]；stdin 可留空。
4. 只在 status 为 succeeded 且输出可解析时使用 stdout 中的 amount。
5. 失败时说明无法完成计算，或按接待规则转人工，不将报错文本直接发给买家。
```

`scripts/calculate.ts`：

```ts
const price: number = Number(process.argv[2]);
const rate: number = Number(process.argv[3]);
if (!Number.isFinite(price) || price < 0 || !Number.isFinite(rate) || rate < 0 || rate > 1) {
  console.error('原价或折扣比例无效');
  process.exit(1);
}
console.log(JSON.stringify({ amount: Number((price * rate).toFixed(2)) }));
```

对应工具参数：

```json
{
  "skillName": "price-calculation",
  "path": "scripts/calculate.ts",
  "args": ["100", "0.9"],
  "stdin": "",
  "timeoutMs": 10000
}
```

`runSkillScript` 的结果包含 `executionId`、`skillId`、`skillName`、`skillRevision`、`contentHash`、`path`、`runtime`、`status`、`stdout`、`stderr`、`exitCode`、`signal`、`durationMs`、`truncated`。状态为 `succeeded`、`failed`、`timed_out`、`cancelled` 或 `output_limit`。退出码不为 0 会返回失败，保留标准错误；输出不代表业务操作一定成功，Agent 需要按技能约定解释。调用不存在、未挂载或不在发布版本中的脚本会触发工具错误并停止本轮自动发送。

## 语言与运行环境

| 文件扩展名 | 运行方式 | 依赖要求 |
| --- | --- | --- |
| `.ts` / `.mts` / `.cts` | Electron 自带 Node，启用 TS 类型转换 | 无需另装 Node / tsx；不运行 tsc，也不读取项目 tsconfig |
| `.js` / `.mjs` / `.cjs` | Electron 自带 Node | `.js` 默认 ESM；CommonJS 使用 `.cjs` |
| `.py` | 本机 PATH 中的 Python 解释器，优先 python3 | 需要本机安装 Python 3 |
| `.sh` | 本机 PATH 中的 Bash | 需要本机安装 Bash，Windows 不默认具备 |

脚本和参考资料来自当前 Skill 的同一个版本。每次调用将完整文件集写入独立的临时目录，并以该目录为工作目录执行。脚本可以相对导入同一技能里的辅助脚本，例如 `./helpers/numbers.ts`；读取资料可使用相对工作目录的 `references/policy.md`。参数通过 argv 传入，可选标准输入通过 stdin 传入，结果建议使用 stdout 输出 JSON。

每次调用使用新目录，执行结束后清理。临时生成的文件不会保留到下一次调用，也不会作为附件自动发送或入库。Skill 包当前只接受文本资料和支持的脚本文件，根目录不接收 package.json 或 lockfile，也不导入二进制依赖或自动安装 npm / pip 包。建议使用内置标准库和同包辅助脚本。

脚本在独立本地进程执行，拥有当前用户的文件与网络权限。这是**可信本地代码机制，不是操作系统安全沙箱**。只使用自己编写或审阅过的代码；脚本试运行同样会执行代码中的真实操作。平台 Cookie、模型密钥和应用业务对象不会通过工具参数或进程环境自动注入，但独立进程并不阻止代码主动读取当前用户有权限访问的文件。需要受平台能力约束的订单查询、发送消息等业务接口，继续通过 Toolkit 宿主适配使用。

执行约束：

- 模型只能选择已挂载 Skill 的固定脚本路径，不能提交任意代码、shell 命令、工作目录或环境变量。参数数组逐项传递，宿主使用 `shell: false`。
- 每次最多 50 个参数，每项最多 2048 字符且不含 NUL；stdin 最多 64000 字符。
- 默认超时 10 秒，可配置 100 毫秒到 30 秒；stdout 与 stderr 合计最多 64 KiB，超出后截断并终止；应用内最多并发 2 个脚本，Node 堆上限 128 MiB。
- 环境仅保留运行所需的 PATH、语言及操作系统字段，不继承模型密钥、Cookie、NODE_OPTIONS 等应用环境变量。
- Agent 超时 / 取消、编辑器停止、应用正常退出时终止脚本。POSIX 使用独立进程组清理后台后代；Windows 通过 taskkill 尽力终止进程树。这些生命周期限制不构成对恶意代码或整机资源使用的完整隔离。

## 按需加载的运行方式

实现使用当前锁定的 Mastra 原生 `Workspace` 与只读 `SkillSource`。该 source 只包含本次 Agent 的技能副本，不回退到宿主文件系统；没有配置通用 Workspace filesystem 或 sandbox。保留原生技能工具，并按需增加专用执行工具。

- 初始模型上下文只含已挂载技能的名称、适用场景及工具说明。
- `skill({ name })` 加载完整正文和文件目录，包含 `references/` 与 `scripts/`。
- `skill_read({ skillName, path })` 读取参考资料或脚本源码；`skill_search` 检索已挂载技能。
- 只有当前 Agent 的挂载副本中存在脚本时，才暴露 `runSkillScript`。读取源码和执行脚本是两个独立动作，加载 Skill 不会自动执行代码。
- 每个子 Agent 只获得自己的已发布 Skill 与脚本，不自动继承父 Agent 或整个技能库。
- 脚本输出作为工具结果交回同一个 Agent 的正常工具循环；没有额外的分类、格式整理或修复模型请求。模型需要依据工具结果组织回复时，仍需要正常的后续生成步骤。
- 生产运行日志的 `usage.scriptExecutions` 保存执行版本、脚本路径、状态、输出与耗时；Agent 试运行的结果和本地调试日志也保留这些信息。

`runSkillScript` 不等于 Mastra 通用的 `mastra_workspace_execute_command`；后者没有开放。Skill 中写了某个 Toolkit 工具名，也不代表自动获得该工具，它仍须挂载并经过现有平台能力检查。

## 发布与版本行为

Agent 草稿保存 `skillIds`，调试和发布时读取技能库里对应 Skill 的最新已保存版本。发布快照保存完整 `skills` 数组，每项包含 id、revision、名称、场景说明、正文、参考资料、脚本及内容哈希。

- 编辑脚本或资料后，已发布 Agent 继续使用发布时的完整副本；保存技能不改变当前工作绑定和接待配置代次。
- 下一次 Agent 试运行读取最新已保存内容；下一次发布冻结新内容，应用新绑定后用于接待。编辑器脚本试运行则直接使用当前未保存草稿。
- 删除技能只从技能库隐藏，不破坏历史发布副本及其中的脚本。草稿会提示“已删除或缺失”，必须移除或替换后才能再次调试、发布。
- 同一个 Agent 不能重复挂载同一 Skill，也不能同时挂载同名 Skill。
- 恢复 Agent 历史版本为草稿时恢复挂载关系，不回滚共享技能库。后续调试和发布仍读取技能库当前保存的内容；被删除的 Skill 需要重新导入或替换。
- 旧草稿读取时补齐空 `skillIds`；没有 Skill 字段的旧发布快照按空技能集执行。已有 Skill 副本但没有 `scripts` 字段的历史快照继续使用旧哈希算法验证，不补写字段，不修改历史 JSON 或绑定哈希。新发布的副本将脚本纳入哈希。

## 导入、导出与备份

“导入技能”支持带 YAML 头的 `SKILL.md`，或包含唯一 `SKILL.md`、`references/` 文本资料、`scripts/` 脚本的 ZIP；ZIP 可额外包一层技能目录。导入先打开编辑器预览，点击“保存技能”才创建本地记录，不自动执行脚本、挂载 Agent 或更换工作绑定。同名导入不会覆盖原 Skill。

导出生成标准 `SKILL.md + references/ + scripts/` ZIP，可在其他本地资料库再次导入。单独导入 `SKILL.md` 不包含其引用的资料或脚本，需在编辑器补充，或导入完整 ZIP。导入校验压缩前后大小、文件数量、UTF-8 文本、路径规范、重复文件、目录冲突与符号链接。

Skill 数据随业务 SQLite 数据库备份和恢复，无需额外复制技能目录。迁移 `202609080002_agent_skills` 创建 `SkillDefinition`；迁移 `202609080003_skill_scripts` 只添加默认 `{}` 的 `scripts` 列，不修改既有 Agent、消息和工作绑定。

## 实现位置与验证

- 契约：`packages/contracts/src/index.ts` 的 Skill schema、脚本调用及结果类型、`skills.*` API。
- 存储、导入导出与快照：`packages/agent-config/src/skills.ts` 和 `packages/agent-config/src/index.ts`。
- 运行：`packages/ai/src/skill-runtime.ts` 的只读原生 Skill source；`skill-scripts.ts` 的进程执行器；`index.ts` 的回复 Agent 挂载与工具入口。
- 桌面宿主：main 传入 Electron 可执行文件路径；utility service 内执行脚本；关闭 service 时取消仍在运行的脚本。
- 界面：`pages-skills.tsx`、`components/skills/` 和 Agent Studio 的 Skills 区域。
- 回归测试：`tests/skills.test.ts` 与 `tests/skill-scripts.test.ts`，覆盖快照、兼容、导入边界、TS/JS 执行、生命周期限制、真实 Mastra 工具循环和父子 Agent 隔离。
- 桌面验证：`scripts/skills-smoke.mjs` 随 `pnpm test:e2e` 运行，覆盖脚本编辑、无需模型的直接试运行、停止、ZIP 往返、Agent 调用内置 Node、发布快照和 1120×760 布局；支持源码构建与打包 `.app`。

## 可用店铺

Skill 编辑器支持配置全部或指定店铺，内容发布快照不携带授权。运行时按当前店铺过滤 Skill 目录、正文、参考资料和脚本，读取/执行时再次校验；撤权对旧发布版本同样生效。资源导出不携带本机店铺 ID。详见[资源可用店铺与通用问答](store-resource-scope.md)。
