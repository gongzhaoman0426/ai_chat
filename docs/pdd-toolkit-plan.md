# 拼多多客服工具箱

> Workflow 扩展已移除，本文中与 Workflow 相关的内容仅为历史记录，见[本地扩展开发](extension-development.md#workflow-已移除)。

> 多平台更新：新建助手默认使用 `builtin/commerce@1.0.0`，在拼多多店铺提供本文能力。旧 `builtin/pdd@1.0.0/@2.0.0` 已从目录与新挂载选项移除，仅保留历史兼容；抖店使用独立实现，不继承 PDD 写操作。见 [多平台路由与兼容](douyin-integration.md)。


日期：2026-09-08。当前状态：本文 PDD 能力已并入 `builtin/commerce@1.0.0`；旧 PDD 工具箱退役，底层拼多多适配器保留。

本次只增加 Agent 可调用能力，不新增商品、订单或视频业务页面。平台真实客服转接（`getassigncslist` / `moveconv`）不接入，仍使用 JuDesk 本机 `handoffToHuman`。视频查询和发送留待后续。自动学习仍由内置评估器执行，结果必须人工审批。

## 1. 如何启用

新建默认助手和首次引导创建的助手默认挂载 v2。已有 Agent 的草稿、已发布版本、工作绑定和 v1 资源哈希不会被后台改写。

已有助手的最新发布配置在启动时定向迁移到“店铺客服工具”，保留用户其他设置及旧修订，更新相应工作绑定；挂载在明确历史版本上的引用继续兼容。手动配置只选择“店铺客服工具”，无需再按平台选 Toolkit。

普通业务无需配置 Workflow。学习角色无权执行工具箱；工具调试和 Agent 隔离调试只返回明确标记的 fixture，备注工具在调试中返回 `debug_readonly`，不会访问真实订单。

## 2. 七个工具

| 成员 ID | 用途 | 参数与结果 |
| --- | --- | --- |
| `goods` | 当前店铺商品分页 | page 1–100，通用 pageSize 1–30（默认 10）；拼多多对小于 10 的值按 10 查询，结果报告实际页大小。返回商品 ID、名称、图片和平台明确返回的拼团标价范围（分）；不是全店关键词搜索。 |
| `goods-detail` | 聚合商品详情和属性 | goodsId。两个 HTTP 请求并发执行；单个失败返回 partial / failedSections，不把查询失败当成没有属性。描述最多 2500 字符，属性最多 40 项。 |
| `goods-skus` | 规格、SKU 查询 | goodsId，offset（默认 0），limit 1–50（默认 30）。返回 nextOffset。仅输出实际返回的 groupPriceCents、quantity，不用零补缺失值；不是结算价或库存承诺。 |
| `buyer-footprint` | 当前买家关联商品候选 | page / pageSize；买家由运行上下文注入，分页兼容规则与 `goods` 相同。保留平台候选分类，不能当作完整浏览时间线；存在多个候选时询问买家。 |
| `history` | 当前买家聊天历史 | cursor，pageSize 1–50（默认 20）。返回 nextCursor、hasMore 和受限文本 / 图片信息；不入站、不触发旧消息自动回复。图片 URL 不等于已经理解图片。 |
| `buyer-orders` | 当前买家订单 | page / pageSize；返回平台订单状态文字、商品摘要和 `orderRef`。这是备注的可信订单来源，不查询其他买家。 |
| `order-remark` | 按买家诉求追加订单备注 | orderRef、note。自动读取 / 保留原备注及标签，提交后读回核对。不能用文本订单号替代 orderRef。 |

五个原计划查询工具之外，补充 `buyer-orders`，用于解决订单备注所需的归属核验。商品和历史查询分别受 goods / history 能力约束；订单查询要求 orders；订单备注同时要求 orders 和 orderRemark。能力不存在时，工具不出现在 Agent 的可调用列表中；平台拒绝或返回结构变化会明确失败。

所有查询都有 operation、subjectId（适用时）、queriedAt、partial、failedSections、data、evidenceRef。商品列表按平台分类返回，并设置输出截断标记；reportedTotal 是平台报告的总量，缺失时为 null，不能据此推断完整库存。价格单位只采用已核对字段，不推断未返回的值。

2026-09-10 只读对照确认：同一账号与买家查询 `/latitude/goods/recommendGoods`，`pageSize=5 / 9` 返回 `3000000 / bad params`，`10 / 15 / 20 / 30` 成功；去掉旧示例的 `type=2` 仍然是 5 失败、10 成功，故问题在分页值。`goods` 同样受影响。拼多多桥接在请求前把小页调整为 10，`data.pagination.pageSize` 表示实际页大小，发生调整时另带 `requestedPageSize`；`page` 仍是平台页码，后续按实际页大小翻页，不能按请求值裁切而遗漏商品。其他平台、订单和历史查询的分页规则保持原样。此修复不重试平台请求、不增加模型调用，也不改变已发布 Toolkit 清单。真实平台拒绝仍记录为失败，并按现有规则暂停该会话的自动发送，不能把错误伪装为空商品列表。

本次验证：修复后的 `buyer-footprint` 与 `goods` 使用原始 `pageSize=5` 均在已登录平台返回成功及真实商品候选，未调用模型或发送消息。`pnpm build` 与 PDD 桥接、宿主、工具、Agent、内置资源兼容共 69 项回归测试通过；小页翻页夹具覆盖实际页大小、无遗漏和单次平台请求。

## 3. 订单备注的实际流程

1. Agent 调用 `buyer-orders`，从当前登录账号、当前买家的 `/latitude/order/userAllOrder` 取得有限分页结果。宿主剔除无关字段，并校验有返回 uid 时与当前买家一致。
2. 业务服务将结果保存为 PlatformEvidence，生成 `order:<证据ID>:<索引>` 引用。引用绑定当前运行、店铺、账号、会话、买家，有效期 5 分钟；不能由 Agent 传任意 orderSn、buyerId 或请求地址。
3. 备注工具核对引用、诉求和当前回复资格，创建持久化 PlatformAction。同一买家消息、目标订单、相同备注使用同一个去重键；同轮并发调用、运行时重建和任务再次处理不重复写。
4. 宿主重新请求对应页的当前买家订单。目标已不在该页时拒绝，要求重新查询；不会盲扫全部订单或放宽归属。
5. 读取 `/pizza/order/note/query` 和 `/pizza/order/noteTag/query`，保留旧备注、标签及标签名称；再次读取并比较，发现并发变化即拒绝。追加后超过平台前端的 300 字符限制时拒绝，不截断已有备注。
6. 提交前，主进程回调业务服务，复核 AbortSignal、买家问题版本、人工接管及工作配置，并持久化本次提交前后内容。服务失效或资格变化会阻止提交。
7. 调用 `/pizza/order/noteTag/update` 后读回备注与标签。只有读回与提交内容一致才返回 confirmed；业务明确拒绝返回 rejected；超时、读回失败或内容不一致返回 unknown。即使平台更新响应超时，也只读回核对，绝不再次提交。

已经完整存在的一行相同备注返回 `already_present`，不重复写入。标签修改暂不作为参数暴露，以免无意清除或改变其他客服标记。备注只表示记录诉求，不等于修改实际收货地址、退款或承诺发货。

平台更新接口没有查到可用的原子追加 / compare-and-swap 版本条件。JuDesk 在本店内部串行操作，并在提交前比较、提交后核对；**无法保证其他电脑或原平台客服恰好在最后一次比较与写入之间修改时不发生覆盖**。unknown 操作不会自动重放，需人工核对平台内容。备注返回 rejected / unknown 时，本地代码会直接结束工具 loop 并进入 JuDesk 待人工状态、发送现有转人工提示，避免模型在下一步误称已完成；不会调用平台客服转接 API。备注工具不增加逐次人工审批或额外模型审核请求。

## 4. 平台资料与自动学习

- 同一回复运行中，相同规范化参数的查询共用请求和证据；不同运行重新查询，不把商品、库存或订单资料当永久缓存。
- PlatformEvidence 保存真正交给回复 Agent 的有限结构化资料、范围、查询时间和引用。原始响应不会完整塞进模型上下文，也不保存 cookie / 认证信息。
- PlatformAction 保存目标、来源引用、去重键、提交前后内容和 confirmed / rejected / unknown 结果。操作回执也保存为本轮平台证据。
- 无论回复最终用正文还是 `submitReply`，实际使用的平台依赖都会保留。学习只加载本次已实际回答所关联的成功回复运行中、同店铺 / 买家 / 会话、回答时间以前且真正被引用的证据。
- 平台证据映射进统一 E1 / E2 清单；旧的临时假 ID、其他运行 / 买家 / 未来资料仍会排除。学习资料中平台事实预算为 30000 字符，超出或无法核验的引用标记为 unavailable，不伪造内容。
- 商品事实形成知识建议必须限定对应商品；价格、库存、买家个人资料和一次性订单备注不沉淀为永久通用答案。所有建议仍是待人工审批。

两个商品 HTTP 请求聚合只算一次工具调用，不增加模型请求。Agent 仍需要正常的工具 loop，例如“查询订单 → 添加备注 → 输出确认正文”通常是三次生成；没有再加审核、格式修复或第二个决策 Agent。

## 5. 来源与实现位置

请求路径主要来自 botsdk；订单读接口与返回字段补充核对了拼多多当前工作台的公开 JavaScript（版本 `chat-merchant-v20260902.14.25.19`）。未登录公共页面会跳转登录页，因此本轮只从本机已有页面缓存识别公开静态资源 URL，再匿名下载代码分析；未调用真实订单更新接口。

- 平台代码 `ordersAll` 使用 `/latitude/order/userAllOrder`，传 uid、pageNo、pageSize、showHistory。
- `orderNotes` 使用 `/pizza/order/note/query`，`saveRemark` 读取 noteTag/query、写 noteTag/update，并检查 success。
- SKU 组件使用 result.sku、specKey / specValue、groupPrice / 100、quantity；属性组件使用 properties[].name / values。
- 原始匿名下载文件保存在本地 `.artifacts/pdd-toolkit-research/`，字段依据同时通过代表性测试夹具固定；这不等于真实账号接口已端到端验收。

| 实现 | 文件 |
| --- | --- |
| 工具清单 / schema | `packages/ai/src/commerce-toolkit.ts`、`packages/contracts/src/commerce-tools.ts` |
| 作用域、缓存、证据及去重 | `packages/ai/src/platform-tools.ts` |
| 平台响应规范化、备注状态处理 | `packages/platforms/src/pdd/queries.ts`、`order-remark.ts` |
| 受限 HTTP 与桌面宿主 | `resources/pdd-bridge.js`（v16）、`apps/desktop/src/main/pdd-host.ts` |
| 主进程与业务服务提交前复核 | `apps/desktop/src/main/index.ts`、`apps/desktop/src/service/index.ts` |
| 学习证据清单 | `packages/core/src/learning-evidence.ts` |
| 增量迁移 | `202609080004_pdd_toolkit`（PlatformEvidence / PlatformAction） |

## 6. 验证边界

新增测试覆盖真实桥接脚本的固定路径 / 参数、业务错误、部分结果、范围限制、输出边界、订单归属、原备注与标签保留、提交前资格变化、并发冲突、超时读回、重复调用 / 重建运行时 / 跨运行去重、v1 哈希与旧引导助手兼容、学习来源清单。

实际 Mastra 使用本地 HTTP 模型夹具验证“订单查询 → 备注 → 最终正文 → 一次确认发送”，共三次正常 loop 模型请求；备注写一次，来源证据能进入后续学习。平台传输和订单读写均模拟，没有使用付费模型或修改真实客户订单。

打包、完整回归与桌面冒烟的结果见[实现与验证记录](implementation-status.md)。真实账号仍受平台页面版本、接口返回和账号权限影响；未知响应会报错，不会冒充查询成功或订单已备注。
