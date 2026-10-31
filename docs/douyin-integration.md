# 抖店接入与多店铺工具路由

> Workflow 扩展已移除，本文中与 Workflow 相关的内容仅为历史记录，见[本地扩展开发](extension-development.md#workflow-已移除)。

> 2026-09-11：本轮新增能力及验证边界见 [客服工具扩展](commerce-capabilities.md)。下文早期能力清单以该文档和当前平台能力表为准。

更新：2026-09-08。代码、契约测试和本地 Electron 验证见本文件末尾。已使用当前登录账号只读核对商品、详情、买家关联商品、空订单和历史查询；账号灰度差异和买家实际收发仍需验收，不把夹具测试当作买家端交付证据。

## 1. 用户如何使用

首次配置和设置中的“添加账号”支持选择拼多多或抖店；工作台和左侧店铺菜单也有平台选择。每个账号拥有独立持久化登录分区。抖店先打开商家登录页（`fxg.jinritemai.com/login`）；登录成功进入商家后台后自动跳到飞鸽工作台，再识别店铺与客服并建立消息监听。关闭平台窗口隐藏窗口并保留后台连接；断开账号才停止连接。

账号识别、消息通道连接、人工确认接入验收、自动回复开关是不同状态。沿用已有引导：测试买家发消息、聚答发送文字、原平台人工发送并同步，确认收发后再启用自动回复。图片上传模块可能按需加载，未加载时只显示文字能力，不能声称图片能力已经可用。

新默认助手、引导生成的助手和 Studio 新建助手挂载 **店铺客服工具** `builtin/commerce@1.0.0`。同一个发布版本可以绑定多个店铺，无需分别挂载拼多多与抖店工具。同一家店的不同客服账号共用该店问答库。

“新建问答”弹窗明确提供“所属店铺”选择，默认当前店铺。保存使用弹窗选中的 storeId，成功后自动切到该店问答库。切换归属时清除已选图片和适用商品 ID；迟到的图片选择结果不能写入另一个店铺的编辑器。编辑已有问答时显示原店铺且不可更改，后端继续校验条目和附件的店铺归属。

可选店铺由 `stores.list` 统一限定为至少保留一个账号的店铺。暂时离线/断开连接不影响维护问答；移除最后一个账号后，即使为保留问答和会话仍存有 Store 记录，也不再出现在选择器中。新建弹窗已选择的店铺若被移除，清空该选择、图片和适用商品并禁止保存，保留文字草稿供重新选店。后台在知识发布前校验账号仍存在，旧编辑请求和待确认导入也不能继续写入已移除店铺。历史数据保留，重新接入同一平台、同一店铺标识后复用原问答。

## 2. Agent 不选择平台，宿主按当前会话装配

```text
同一个 Agent 发布版本（提示词、Skills、Toolkit、Workflow、子 Agent）
  ├─ 拼多多店 A 的回复执行 → A 的账号/买家/知识 → 拼多多可用工具
  └─ 抖店 B 的回复执行     → B 的账号/买家/知识 → 抖店可用工具

模型调用 builtin/commerce/goods 等统一业务工具
  → 当前运行的 ScopedAssetContext
  → 平台业务证据与权限检查
  → accountId 对应 PlatformHosts 驱动
  → 对应平台登录分区、页面 bridge、原始会话
```

- `resolveReplyScope` 从业务库读取账号、Store.platform 和会话，再核验 storeId/accountId/conversationId/buyerId 一致。界面当前选择、提示词内容、模型参数不能覆盖范围。
- 模型输入 schema 没有 platform/storeId/accountId/buyerId/conversationKey。业务进程补入当前范围；抖店会话、普通用户 ID、安全用户 ID 都来自实际观测，不接受模型生成。
- 每轮、每个子 Agent 分别创建工具实例和上下文。不存在全局“当前平台”变量，也不跨运行共享查询缓存。子 Agent 继承相同店铺/买家，同时对父子允许操作取交集，不能提升权限。
- 工具可见集合为：挂载资源 × 资源适用平台 × 平台实现的操作 × 账号实时能力 × 父级允许范围。执行时再次校验；只隐藏按钮不构成范围保障。
- 同时挂载旧 PDD 与通用工具时，只向模型提供通用成员，避免同一功能重复暴露。只挂载 PDD 专用工具的自定义 Agent 在抖店执行时不提供这些工具；仍可使用本店问答和其余适用资源。
- 平台路由是普通 TypeScript 分支和查表，不增加模型请求。正常工具决策和工具结果后的回答仍由 Mastra 原有循环完成。

## 3. 平台能力矩阵

| 能力 | 拼多多 | 抖店 |
| --- | --- | --- |
| 登录识别、多账号隔离、后台恢复 | 保留 | 已接入 |
| 新消息、平台人工回答观测 | 保留 | message$ + 人工发送状态更新 |
| 文字发送、迟到回执 | 保留 | sendText + serverId/flightStatus + 对应事件 |
| 图片发送 | 保留 | Webpack 上传函数 + _sendMsg；需模块加载 |
| 店铺商品、商品详情 | 已有 | 已接入限定接口 |
| 买家关联商品、历史、买家订单 | 已有 | 已接入；依赖当前买家标识/安全会话字段 |
| SKU 查询 | 已有 | 暂不暴露，未建立独立契约 |
| 追加订单备注 | 保留旧备注/标签并读回核验 | 暂不暴露，飞鸽探路笔记的写入示例不足以证明可核验读写闭环 |
| 平台真实客服转接 | 仅人工操作，不提供给 Agent | 已接入接待中心，详见[接待中心与业务操作](reception-workbench.md#抖店可转接客服列表) |

抖店列表、详情、订单仅输出选定业务字段；长 ID 保持字符串，发生数值精度丢失时拒绝。数值价格未核实单位时不猜单位，只使用明确的展示字符串。接口业务失败或列表格式未知时报错，不把它当作“空列表”“没有订单”或“没有商品”。业务查询产出本轮、当前店铺限定的 `PlatformEvidence`，可供回复及本店学习引用。

## 4. 抖店桥接依据和发送确认

飞鸽控制台探路笔记在 [references/douyin-feige-console.js](references/douyin-feige-console.js)，不直接执行。实际资源为 `resources/douyin-bridge.js`，宿主为 `DouyinHost`，与 PDD 共用 `WorkbenchHost` 的窗口、分区、导航代次、事件入队/ACK、身份验证、图片下载限制和关闭逻辑。

2026-09-08 只读获取当前飞鸽公开页面及其加载脚本，补充验证了探路笔记未给出的字段。没有使用商家 Cookie 下载，没有执行参考文件中的硬编码发送或订单操作。

| 核对项 | 依据 |
| --- | --- |
| 页面入口 | 先打开 `https://fxg.jinritemai.com/login`；登录后进入飞鸽 `https://im.jinritemai.com/pc_seller_v2/`。`pigeon.jinritemai.com` 是示例业务接口域名，不能当登录入口 |
| 公开资源 | `ecom_im_pc/pages/pc_seller_v2/index.40d33eeb.js`、`ecom_im_pc/27399.de327e7b.js`、`ecom_im_pc/common/397.77e27437.js`，来自入口 HTML 声明的 `lf3-fe.ecombdstatic.com` |
| 商品详情 | 当前页面调用 `/backstage/productdetail`，已替换参考片段的旧 `/pcbackstage/productdetail` 路径 |
| 身份 | currentuser 返回 `ShopId/ShopName/CustomerServiceInfo.id/screen_name` |
| 消息 | `serverId/conversationId/createTime/originExt`；`ext.sender_role` 中 1 为买家、2 为客服、3 为系统、4 为店铺 |
| 发送状态 | SDK `flightStatus`：0 创建、1 准备、2 发送中、3 成功、4 已接收、-1 失败、-2 拒绝、-3 仅自己可见 |
| 原平台人工发送 | SDK 的 `onMessageChange` 返回可清理订阅；发送中事件不能直接当实际回答 |
| 会话标识 | SDK `parseBizConversationId` 验证六段地址；只在匹配登录店铺后读取，保留完整会话 ID，不拼接新地址 |
| Webpack 图片上传 | `doImageXUpload` 特征模块及 `iP` 导出，与参考片段一致；此内部导出随构建可能变化 |

发送命令使用本地 outbound ID 关联 `p:check_Send` / 图片 uuid。SDK 调用返回值必须含有效平台消息 ID 且不能处于发送中、失败、拒绝或仅自己可见状态；事件回执还须匹配本次命令标识和原始会话。`undefined`、客户端 ID、泛化的 success、相同文本均不能当已送达。12 秒未确认记录 unknown，保留迟到确认路径，不自动再次发送。

主消息订阅与状态更新订阅都可清理；重复注入不重复监听，更换 SDK 后重新绑定。队列有容量限制，主进程处理成功后才 ACK。历史/离线回放只入库，不触发新的自动回复或学习回合。新消息形状无法识别时只记录字段名和计数，不打印客户正文或凭据。

页面没有持久化事件日志：页面崩溃/彻底刷新时，尚未传到本地库的事件可能丢失。当前提供按需历史查询，没有实现自动按平台游标补齐全部断线缺口；不能承诺页面崩溃下零丢消息。

## 5. 每个店铺单独维护、单独学习

**共享 Agent 不会共享店铺专属知识、记忆和学习结果。** 人工维护的通用问答与图片可跨店使用；自动学习仍以店铺为边界。资源另受[可用店铺授权](store-resource-scope.md)限制，平台只是店铺的属性。

| 数据/处理 | 隔离规则 |
| --- | --- |
| Store | 唯一键改为 `(platform, externalId)`，不同平台同号店铺不会合并 |
| Conversation/Message | storeId + 外部会话/消息标识；相同买家 ID 不跨店归并 |
| 问答及图片 | KnowledgeEntry/Attachment 的 storeId=null 为通用，其余为店铺专属；本店可读通用与自己的条目/图片 |
| 语义检索 | 向量查询包含本店与通用，返回结果再次核对归属、启用和版本 |
| Agent Memory | thread/resource 包含 storeId 和 conversationId，不按 Agent ID 全局共享 |
| 学习开关、模型/额度、游标 | LearningPolicy/学习订阅按 storeId 独立维护；关闭一家不影响其他店 |
| 学习证据 | 问题、回答、上下文、执行记录、平台事实均限定当前店铺会话 |
| 学习建议和审批 | 候选固定原 storeId；待审批不进入正式知识，批准后只发布到来源店铺 |
| 页面切换 | 问答、学习和工作台按 storeId 重新挂载，清理上一店的编辑框、审批选择和输入状态 |

未绑定店铺的人工问答组成通用库；不会在新接入店铺时复制其他店专属知识，也不会把自动学习结果自动升级为通用问答。

## 6. 扩展 SDK 与兼容

Manifest 增加可选 `platforms: ['pinduoduo' | 'douyin']` 和成员级 `requiresOperations`；上下文增加只读 `platform.id`、`platform.operations`。平台无关 Workflow/Toolkit 不写 platforms 即可适用于所有已实现平台，但实际 query/action 仍受当前运行范围限制。

```ts
// 一个只读订单工具/流程成员的声明
{
  requiresCapabilities: ['orders'],
  requiresOperations: ['buyer-orders']
}
// 工厂中不接受店铺/账号/买家参数
const orders = await ctx.platform.query('buyer-orders', { page: 1, pageSize: 10 });
```

PDD 专用 Toolkit 已退役：新安装仅注册“店铺客服工具”和“基础工具”，资源目录与挂载选择不展示 `builtin/pdd@1.0.0` / `@2.0.0`。原文件移到 `packages/ai/src/compatibility/pdd-toolkit.ts`；历史清单/哈希不变，v2 工具委托通用实现，既有历史修订仍可在拼多多执行。

启动时按工具 ID 定向迁移全部有效 Agent 的最新发布修订，包括改过 maxSteps、模型、提示词的助手。只替换旧 Toolkit 并合并重复的通用挂载，保留已发布模型/Skill 快照与其他配置；生成新修订，更新指向旧最新版的工作绑定与子 Agent 链，并维护子 Agent 关系索引和配置代次。明确绑定的历史修订保留兼容执行，不原地改写。草稿独立迁移工具/子 Agent 引用，其余未发布内容不会发布。迁移记录审计且可重复运行。

保存、导入或恢复旧配置也会将退役 ID 归一化为通用工具，不能通过旧配置重新在草稿中挂载 PDD 集合。上述工具迁移独立于默认提示词升级，不要求整个助手匹配默认模板。

数据库迁移 `202609080005_multi_platform` 保留所有主键和原 PDD 数据；连接状态配置从 `pdd.*` 迁移到 `platform.*`；会话增加平台上下文 JSON。新消息触发的查询缓存/证据、AI 回复和学习均不依赖界面所选店铺。

Studio 的隔离试运行可选择模拟拼多多或抖店，观察不同工具列表；使用夹具数据，不连接真实店铺或修改订单。

## 7. 验证与边界

- 本次完整 `pnpm test`：25 个测试文件、243 项测试通过。随后补充组件化订单断言，相关 4 个文件、20 项测试通过。`pnpm build`（含 Prisma 生成和类型检查）、变更文件格式检查与 `git diff --check` 通过。
- `pnpm test:e2e` 全部通过。`scripts/douyin-smoke.mjs` 在临时资料目录使用真实 Electron 宿主、资源注入脚本、IPC 和业务进程，只有抖店网络页面替换成夹具；覆盖平台选择、登录身份登记、跨平台同号店铺、新消息入库、文本发送及精确回执、原平台人工回复同步、五种业务查询、店铺切换、问答归属选择/固定归属编辑和图片切店清理。没有连接真实商家发送测试消息。
- 桌面截图保存在本地 `.artifacts/douyin-workspace.png` 和 `.artifacts/douyin-knowledge.png`，仅含临时夹具数据。本轮构建更新 `out/`，未重新生成 Windows/macOS 安装包。
- 单元/集成覆盖：平台账号路由、同号店铺隔离、工具按平台/操作裁剪、伪造 scope 拒绝、并发 Mastra 执行、接收订阅清理、原平台人工作答、历史不回复、精确回执/迟到回执、真实 SDK 字段、图片上传、独立学习/审批/发布。
- 同一真实 Mastra Agent 发布版本同时处理 PDD 与抖店测试会话：各一次查询及其后的回答，共 4 次模型请求；没有额外平台路由或格式化模型请求。
- 当前真实账号的只读查询结果见下节。尚未实测：其他账号灰度差异、实际买家收到消息、跨进程异常时的恢复范围、图片 CDN/上传权限和非空组件化订单。首次登录的原有接入验收仍需完成。
- 版本变化时仅修改对应平台桥接及归一化；不需要让用户改提示词选择新的 API。


## 8. 2026-09-08 商品工具故障修复与实测

从本地实际运行的 Mastra 工具记录定位到商品列表、买家关联商品均报“抖店商品 ID 无效或发生数字精度丢失”。在已登录飞鸽页面只读执行相同 bridge.query，确认 HTTP/API 查询成功，失败发生在 JuDesk 返回归一化。

| 操作 | 当前账号真实返回 | 修正 |
| --- | --- | --- |
| 店铺商品、买家关联商品 | `data[]` 保留空的旧 `product_id/product_name/img` 字段，实际资料在 `product_item` | 读取 `product_item.product_id`、`product_base_info.title/main_img`，从显示价格结构提取报价和前缀；不使用已舍入的 SKU 数字 ID |
| 商品详情 | `data.product_id/name` 仍是扁平结构，`sku_min_price_str/sku_max_price_str` 的单位为分 | 同时支持旧结构；按照飞鸽渲染规则将分转换为元，保留区间，严格核对返回商品 ID |
| 聊天历史 | `data.msgList[]` 内含 `serverMessageId/messageBody`，分页字段是 `nextCursor` | 提取正文、类型、时间和发送者，保留原始精确游标 |
| 当前买家订单 | 本次账号返回 `data: [], componentized_data: [], total: 0` | 确认为空；若旧列表为空但组件化数据非空/第一页 total 非零，明确报未识别，不能告诉买家“没有订单” |

当前商品 GET、详情 GET、买家关联商品 GET、订单 POST 和历史 GET 路径都能在该账号返回，未因为静态代码里存在其他版本就盲目切换路径。未向真实买家发送测试消息，也未修改订单。未新增平台路由、审核或格式修复模型请求。

`check_spam_resp.decision` 非 PASS 时不使用受限/脱敏数据，提示在平台完成验证。真正不安全的数字 ID 继续拒绝，缺失 ID 与精度丢失分别给出具体原因。分页优先读取平台 has_more，其次使用明确的 total；没有分页依据时返回 null。

运行记录保存 `usage.platformErrors`（操作名及简短错误），终态 error 带具体平台工具失败原因，替代单一“模型或工具执行失败”。失败仍停止自动发送；不为修复工具结果额外请求模型。

最小化、匿名化后的实测结构保存在 `tests/fixtures-douyin-query.ts`。回归包括真实 Mastra 工具循环成功/失败、跨平台同一助手的店铺范围、无多余模型请求，以及实际 Electron 主进程 dispatch → WorkbenchHost → 注入桥接 → 返回归一化。桌面场景只替换平台网络页面；另覆盖问答显式选店、目标店独占保存、编辑归属锁定和图片切店清理。截图 `.artifacts/knowledge-store-selector.png` 仅含测试数据。
