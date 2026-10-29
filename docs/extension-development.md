# 本地扩展开发

实现版本：JuDesk 0.1.0，SDK `apiVersion: 1`。

## 集合与成员

Toolkit 通过 `createTools(context)` 返回原生 Mastra Tool Map；Workflow 通过 `createWorkflows(context)` 返回已 `commit()` 的 Mastra Workflow Map。一个集合可以包含多个成员。成员完整 ID 为 `assetId/memberId`，例如 `local/shop-helpers/greeting`；安装版本 ID 为 `local/shop-helpers@1.0.0`。

Toolkit 挂载使用包名 `local/shop-helpers`，自动跟随本机已安装、已启用的最高语义版本；旧的版本 ID 挂载也按包解析。更新 ZIP 后无需重新发布 Agent。单轮锁定实际代码与设置，下一轮使用更新。Workflow 仍按所选版本运行。完整规则见 [Toolkit 自动使用最新版](toolkit-latest.md)。

接口定义在 [extension-sdk](../packages/extension-sdk/src/index.ts)。直接参考 [Toolkit 示例](../toolkits/local/shop-helpers/index.ts) 和 [Workflow 示例](../workflows/local/reply-polish/index.ts)。

`manifest` 声明 `apiVersion`、`assetId`、语义版本、集合类型、名称、描述、`settingsFields` 和 `members`。成员分别声明输入 / 输出 JSON Schema、所需平台能力。工厂实际导出的成员必须与清单一致，不允许少导出、额外导出或重复成员 ID。

## 打包与安装

执行 `pnpm extensions:build` 将项目内两个示例打包成 ZIP。修改构建脚本的 source 数组可以增加自己的集合。

```text
extension.zip
├── manifest.json
└── index.mjs
```

首版仅接受这两个文件。除宿主提供的 `@mastra/core/*`、`zod` 和 Node 内置模块外，依赖应在构建时打进 `index.mjs`。不在运行中下载 npm 包，不把源码目录当作生产扩展直接执行。

安装后代码放到资料库 `extensions/<assetId>/<version>/<hash>/`；相同版本不能替换为另一份代码，必须递增版本。模块每次装配会核对静态清单、模块清单及产物哈希。安装新版本不会修改已发布 Agent 的旧依赖。

开启开发者模式 → 资源目录安装 ZIP → 配置集合设置 → 按成员试跑 → 在回复 Agent 挂载集合 → 发布 → 设置工作绑定。

## 宿主上下文

| 接口 | 行为 |
| --- | --- |
| `role` | 生产回复为 `reply`，隔离试跑为 `debug` |
| `storeId / accountId / conversationId / runId` | 当前运行范围，由宿主注入 |
| `signal` | 取消和超时信号，外部 I/O 应传入它 |
| `settings` | 全局设置合并店铺覆盖；密钥在运行时解密 |
| `knowledge.search(query)` | 当前店铺已生效的问答检索，调试返回夹具 |
| `platform.query(operation, input)` | 受当前账号能力与挂载集合约束的只读平台查询 |
| `platform.action?(operation, input)` | 可选的受限业务操作接口；当前仅 order-remark |
| `agents.runSub(alias, input)` | 调用配置中锁定修订的子 Agent，权限和调用深度受父级约束 |
| `logger.info(message)` | SDK 日志接口；首版不作为业务审计渠道 |

业务输入不能改变店铺、账号、买家路由。平台查询会覆盖 `buyerId` 为当前会话买家。扩展结果返回 Agent 或宿主，再统一通过发送前检查和 OutboundMessage 发送。

SDK 不提供向买家发送、审批、发布知识或替换学习 Agent 的接口。平台读能力以实际账号为准，缺少能力的成员不会暴露给模型。当前 PDD v2 支持 `goods`、`goods-detail`、`goods-skus`、`buyer-footprint`、`history`、`buyer-orders` 查询，以及单独的 `order-remark` 操作。v1 保留原两个成员。

本地 JS 运行在有 Node 权限的业务进程；以上是可信扩展遵守的宿主业务契约，不是阻止恶意扩展访问系统的 OS 沙箱。

## Workflow 作为 Agent 能力

Workflow 与 Toolkit 使用同一种挂载方式：在 Agent 编辑器选择集合，发布配置后，由工作 Agent 根据当前问题决定调用哪个成员。工作绑定只选择 Agent，不需要再指定流程或策略入口。

每个成员定义自己的输入和输出。例如 `local/reply-polish@1.1.0` 提供两个不调用模型的成员：

- `normalize`：接收 `{ "text": "待整理文本" }`，返回清理后的 `{ "text": "整理后文本" }`。
- `paragraphs`：先清理换行，再按空行分段，返回 `{ "paragraphs": ["商品规格", "发货说明"] }`。

Workflow 结果交给调用它的 Agent，最终回复或转人工候选仍由 Agent 与宿主处理。高阈值问答直答、接待资格、发送确认、学习事件和人工审批由宿主负责。

自 2026-09-08 起不再支持独立回复策略入口，也不提供 `agents.runSelected`。旧版 `contract: "reply.v1"` 仅用于读取已安装清单，相关成员不显示、不可执行，新安装拒绝这种声明。旧集合中普通成员继续可用。修改扩展请递增版本，不覆盖旧版本或改写已发布 Agent 的依赖哈希。

## 调试和生效

成员试跑按静态输入 / 输出 schema 校验，平台与知识为夹具。Agent 调试实际运行配置中的工具、Workflow 和子 Agent，使用独立 Memory，不写生产发送、学习或知识表。模型用量在结果与 `sandbox/runs.jsonl` 中可见。

保存草稿不会改变工作绑定。发布产生不可变修订；已绑定该 Agent 的工作入口自动切到最新版，并校验依赖、循环和必填设置。全局 / 店铺设置修改产生新 revision，更新配置代次；已经开始的旧回复必须重新规划或取消。

## 调试边界

当前只支持本地安装和 JSON 配置导入 / 导出，没有在线市场、包签名、自动更新或远程执行。导入 Agent 是草稿，不自动安装依赖或设置工作绑定。没有提供学习角色的用户扩展接口。


## 平台工具 v2（2026-09-08）

内置 `builtin/commerce@1.0.0` 通过 `ScopedAssetContext.platform.query` 调用受限查询。查询输入 schema 不包含 buyerId / storeId / accountId，范围由运行上下文注入；返回持久化 evidenceRef。新增可选 `platform.action(operation, input)`，当前仅支持 order-remark，且只在声明并获得 orders / orderRemark 能力的回复工具中可用。使用本轮 buyer-orders 返回的 orderRef，不传平台 orderSn；调试不会操作真实平台。旧扩展上下文的 action 字段可缺省。

固定 HTTP、旧备注合并、读回确认和去重均由宿主 / 业务服务完成，扩展不能经 query 调用写接口。每个 Agent 只能挂载同一资源的一个版本，防止同名成员互相覆盖。工具能力和完整契约见 [pdd-toolkit-plan.md](pdd-toolkit-plan.md)。


## 多平台与店铺范围（2026-09-08）

新增 `builtin/commerce@1.0.0` 店铺客服工具。Agent 可以复用同一发布版本接待多个店铺，工具由当前会话和账号决定平台；店铺专属问答、图片、Memory、学习任务和审批建议按店铺隔离；人工维护的通用问答/图片可跨店使用。四类资源另有本地可用店铺授权，见[资源可用店铺与通用问答](store-resource-scope.md)。

Manifest 可选 `platforms` 限定适用平台，成员可选 `requiresOperations` 精确声明业务操作；上下文提供 `platform.id` 和 `platform.operations`。宿主拒绝未授权操作，不向模型开放修改店铺/账号/买家的参数。详情、兼容迁移及测试说明见 [抖店接入与多店铺工具路由](douyin-integration.md)。
