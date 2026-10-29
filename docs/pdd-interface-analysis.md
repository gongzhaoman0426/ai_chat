# botsdk 拼多多接口覆盖与 JuDesk 扩展能力分析

分析日期：2026-09-08。范围为当前本地 `botsdk` 与 `judesk` 源码。本文件保留最初接口盘点，并标注本轮实现变化；代码已实现不等于当前拼多多账号实测通过。此次未调用真实平台业务接口，也未修改店铺、订单或接待配置。

## 当前范围修订：只扩展 Agent Toolkit

实施更新：`builtin/pdd@2.0.0` 已完成 5 个原计划查询工具，以及当前买家订单查询、追加订单备注，共 7 个成员。v1 继续保留。补充核对平台公开前端后，已找到订单归属查询与旧备注 / 标签读取，具体流程、限制和证据保存见[工具箱实现](pdd-toolkit-plan.md)。下面未特别更新的“现状”描述是最初盘点基线。

用户已明确：只把合适的拼多多能力封装成 Toolkit 挂给回复 Agent，**不做平台真实客服转接，也不为这些接口新增商品 / 订单 / 视频等业务页面**。下面的接口盘点继续作为代码事实保留；第 5 节的产品场景仅用于说明可能性，第 7、9 节的封装与实施建议已按此次要求收敛。

- 排除 `getassigncslist`、`moveconv`，保留 JuDesk 已有的本机 `handoffToHuman`。
- 首批聚焦 5 个查询工具：店铺商品、商品详情（包含属性）、SKU、当前买家足迹、当前买家历史。前后两项已有实现，重点增强结果结构并补中间三项。
- 订单备注适合做操作工具，但需要一并解决目标订单核验、旧备注读取 / 合并和业务结果确认；现有单个更新接口不足以完成这条链路。
- 视频素材与回复视频作为后续配套工具，不先挂一个 Agent 查到后无法发送的素材列表。
- 已读、在线状态、输入状态、页面定位与登录凭据留在宿主，现阶段不因本轮 Toolkit 需求另外实现。

详细取舍与工具契约见[拼多多 Agent Toolkit 选型](pdd-toolkit-plan.md)。当前代码已实现 v2，新助手默认挂载；已有工作绑定需用户显式升级。

## 1. 结论与统计口径

JuDesk 当前主要完成消息接待链路，拼多多业务操作的覆盖面明显小于 botsdk：文字 / 图片发送、接收与回执处理已有实现；原 v1 Toolkit 只有商品列表与历史两个工具；v2 现有 7 个成员，详见上面的实施更新。平台会话列表在桥接层有读取实现，但没有接成工作台完整同步流程。

botsdk 的 WebSocket 分发器有 **20 个 method 分支**，其中 `getcurrentuid` 是空分支，另外 19 个接到了处理代码。除此以外，还存在商品详情、商品属性和客服在线状态 3 项实现，分别从 AI 工具类或托盘入口调用。统计的是明确调用路径，不是实际账号验证通过的接口数量；两边都有本地等价功能，因此不以简单接口比例作为完成度。

还应单独区分：

- `receiveNewMessage`、`sendedMessage` 是消息上报事件，不是这 20 个请求方法。
- `heartbeat` 只在分发之前处理，不算拼多多业务接口。
- `ordersAll`、`littlePayApply`、`updatePrice` 等只是识别网页模块时检查的方法名，当前没有封装对应请求或业务流程。
- `MallTool.GetOneGoodAsync` 返回空字符串；DTO 中存在 `couponAmount` 不等于已经实现发券。

依据：[botsdk 分发器](../../botsdk/PddWorkbench/WebSocket/BotWebSocketServer.cs)、[主窗口平台方法](../../botsdk/PddWorkbench/Windows/MainWindow.axaml.cs)、[AI 工具类](../../botsdk/PddWorkbench/AI/Tools/MallTool.cs)、[JuDesk 内置工具](../packages/ai/src/assets.ts)、[JuDesk 平台桥接](../resources/pdd-bridge.js)。

## 2. 全部 WebSocket 方法对照

“已接入”仅表示 JuDesk 有对应代码路径；当前商家账号权限、返回字段及页面版本仍需另行实测。

| botsdk 方法 | botsdk 的实际行为 | JuDesk 当前状态 | 补齐或完善后能做什么 |
| --- | --- | --- | --- |
| `sendtext` | 调用网页 IM SDK 发文字 | 已接入，另有持久化发送意图与精确回执 | 已支持人工 / AI 文字接待；继续沿用 JuDesk 的发送状态机 |
| `sendimage` | 上传图片，再调用 IM SDK 发图片 | 已接入，支持附件、话术图片与确认发送 | 已支持文字 + 图片客服，不能将 botsdk 的直接调用作为回执替代 |
| `sendvideo` | 按视频 URL 调用平台素材发送接口 | 未接入；发送契约目前仅 text / image | 发送安装教程、使用说明、售后排查视频；还需素材选择、消息渲染和发送回执 |
| `convtyping` | 通知平台当前买家会话正在输入 | 未接入 | AI 正在处理时显示输入状态；应节流并随完成 / 取消停止，不调用模型 |
| `moveconv` | 调用 IM SDK 转给指定客服 `csid`，附转接备注 | 未接入；现有 handoff 是本机待人工状态 | 真正转给平台售前 / 售后客服，附原因和已处理摘要 |
| `selectconv` | 选中对应账号页，调用 `startChatByUid` 打开买家会话 | 仅有 JuDesk 本地会话选择，未联动原平台 | 从聚答一键定位原平台该买家，便于处理复杂场景 |
| `getanticontent` | 调用网页风控组件生成请求上下文值 | 未接入 | 只在确有需要的平台请求中内部使用，不作为客服功能或 Agent 工具 |
| `getmalls` | 返回已登录账号 / 店铺集合 | 有等价的本地店铺和账号列表 | 无需复制 WebSocket 接口；继续用本地账号隔离与店铺切换 |
| `getcurrentmall` | 返回当前平台标签及其 `currentUserInfo.userInfo` | 有本地当前店铺 / 会话；没有完整同步原平台当前买家资料 | 对齐原平台焦点，补充买家昵称、备注等实际返回字段 |
| `getassigncslist` | 读取可分配客服列表 | 未接入 | 显示平台可转接客服，按在线状态选择转接目标；部门对应关系需自行配置或来自返回字段 |
| `getchatlist` | 读取平台 Vue store 的 `chatList` | 桥接和 host 支持 `conversations`，未挂成 Agent 工具，工作台列表查询本地 DB | 首次接入时补齐会话清单、发现漏同步会话；历史同步仍需独立游标与去重 |
| `getcurrentuid` | 空 `case`，没有返回实现 | 不应算作已存在的待移植能力；JuDesk 已知道本地选中会话的 buyerId | 若需要原平台焦点 uid，应补明确读取实现 |
| `getpassid` | 从浏览器 Cookie 读取 PASS_ID 并返回 | 没有对外导出；现有平台 fetch 通过浏览器会话自动带 Cookie | 鉴权已有等价机制，应保留在平台宿主，不向 Agent 或普通界面暴露 |
| `markread` | 请求平台将该买家会话标为已读 | 本地打开会话会清 unread，未同步平台已读 | 聚答与平台未读状态一致；必须约定人工查看还是 AI 确认回复后标记 |
| `getvideos` | 查询店铺视频素材，含分页、排序和审核状态筛选 | 未接入 | 视频素材库、按商品 / 场景选择教程；代码只查素材，没有上传视频实现 |
| `getgoods` | 查询店铺推荐商品列表 | 已接入；Agent 只传 page，桥接固定每页 20 | 完善商品侧栏、搜索与分页；搜索能力不能假定当前接口天然支持 |
| `getgoodsskus` | 根据 goodsId 查询 SKU 列表 | 未接入 | 规格选择、颜色 / 尺码对比；库存和价格以实际返回字段及有效时间为准 |
| `getfootprint` | 同推荐商品接口传 uid 与 type=2 | 未接入 | 用买家关联商品候选辅助理解“这个”“刚才看的那个”；不能假定是完整浏览轨迹，也不能单凭足迹确定唯一商品 |
| `gethistorymessages` | 按买家、cursor 和 pageSize 取平台历史 | 已接入查询工具；桥接固定 50 条，本地消息分页不等于平台补拉 | 补齐历史接待上下文、跨客服交接；旧消息不得作为新问题自动补答 |
| `updateorderremark` | 按订单号更新备注、标签颜色与标签名 | 未接入；当前 `orders` 能力明确为 false | 将买家要求写进平台订单、打处理标记、协同仓库和人工客服 |

JuDesk 的平台白名单现在仅有 `goods`、`history`、`conversations`，见 [PddHost.query](../apps/desktop/src/main/pdd-host.ts) 和 [bridge.query](../resources/pdd-bridge.js)。Agent 可直接调用的拼多多查询只有前两个，见 [builtin/pdd](../packages/ai/src/assets.ts)。本地已读与转人工状态见 [Engine.setOpened / handoffTx](../packages/core/src/engine.ts)。

## 3. WebSocket 之外已经写出的能力

| 方法 | 实际调用 | 入口 | JuDesk 状态与价值 |
| --- | --- | --- | --- |
| `GetGoodsDetailAsync` | `/glide/v2/mms/query/commit/on_shop/detail`，传 goods_id | MallTool 包装；未接 WebSocket 分支 | 未接入；补商品详情，为参数 / 卖点 / 使用咨询提供商品依据 |
| `GetGoodPropertiesAsync` | `/latitude/goods/goodsProperties`，传 goodsId | MallTool 包装；未接 WebSocket 分支 | 未接入；结构化读取属性，减少仅靠商品名作答 |
| `SetAllCsStatus` | `_imsdk.setCsStatus(status)` | 托盘在线 / 忙碌 / 离线 | 未接入；管理平台接待状态。JuDesk 断开消息通道或关闭 AI 不等于平台离线 |

botsdk 的状态入口实际传值是在线 1、忙碌 0、离线 3，且对所有已打开平台页执行。JuDesk 如集成，建议按账号控制并读取平台结果，不照搬“全部账号一起切换”的默认行为。这些值是本仓库实现，不作为当前平台版本的外部契约。

依据：[MainWindow](../../botsdk/PddWorkbench/Windows/MainWindow.axaml.cs) 的 `GetGoodsDetailAsync`、`GetGoodPropertiesAsync`、`SetAllCsStatus`，[托盘调用](../../botsdk/PddWorkbench/App.axaml.cs)。

## 4. 以订单备注为例：它能完成什么，缺什么

botsdk 的 `UpdateOrderRemark` 向 `/pizza/order/noteTag/update` 发 POST，提交：

```ts
{
  orderSn,      // 已经知道的订单号
  remark,       // 本次提交的备注文本
  remarkTag,    // 标签代码，如源码示例中的 RED
  remarkTagName,// 标签名称
  source: 1
}
```

它的外层 `mallid` 实际用于查找 `MallCsId`，并非直接传商家店铺 ID。`moveconv` 的 `tomallid` 最后也是作为目标客服 `csid` 使用。JuDesk 应把 storeId、accountId、buyerId、orderSn、targetCsId 分别建模，避免沿用这些歧义命名。

可以在 JuDesk 中提供这些业务流程：

- 人工在会话侧栏选中订单，填写备注与标签，无需来回切平台。
- 买家说“请加固包装”，Agent 提取要求，把它写进已明确选中的本店订单；确认成功后回复“已为您备注加固包装要求”。这不等于承诺仓库必然完成。
- 售后客服把“客户反馈少件，待核实”写为订单处理备注，转接下一位客服时同步摘要。
- 通过自定义 Skill / Workflow 统一备注格式、保留原文、避免重复添加同一个要求。

**不能由这一个接口推导出的能力**：查询买家有哪些订单、读取现有订单备注、查询物流、修改收货地址、改变发货状态、退款、赔付、发券。当前仓库没有这些完整对外实现。订单备注里的“改地址”文字不会改变实际收货地址。

要让 AI 可用，必须补上订单来源与匹配：来自人工选中、可验证的订单卡片，或后续单独实现的本店 / 当前买家订单查询。拿到一个任意订单号不等于已确认它属于当前买家。

备注更新也不能默认理解为追加。现有代码只提交新 remark，没有读取、合并或并发版本检查。需要先确认平台覆盖规则，再设计保留旧备注、记录提交前后内容、重复调用去重及未知结果处理；当前 botsdk 仅返回 response.Content，没有把业务成功 / 拒绝 / 不确定统一成契约。

依据：[UpdateOrderRemark](../../botsdk/PddWorkbench/Windows/MainWindow.axaml.cs)、[MallInfo.MallCsId](../../botsdk/PddWorkbench/Dtos/MallInfo.cs)、[WebSocketParam](../../botsdk/PddWorkbench/Dtos/WebSocketParam.cs)。

## 5. 补齐后最有价值的五组产品能力

以下是基于接口组合提出的功能设计，需要补数据和界面，不是复制请求后自动获得的现成功能。

### 5.1 了解商品的售前客服

组合商品列表、详情、属性、SKU、足迹和会话消息，形成当前买家的商品候选。Agent 能围绕具体商品询问规格、核对参数、比较选项，再结合店铺已经批准的问答进行回答。

界面只需在会话右侧增加「商品」信息卡和候选选择。商品足迹有歧义时让买家确认，不能直接认为最近浏览的商品就是问题对象。价格 / 库存等动态字段按实际返回能力和查询时间使用。

现有问答 scope 已有 productIds，但检索仅按 storeId 过滤；高阈值直答只接受无 productIds、无条件的问答。因此要获得商品级自动直答，还需补商品上下文匹配及其发送前复核，不能接了足迹后直接放开所有商品范围的直答。

依据：[AI.search](../packages/ai/src/index.ts)、[直答选择](../packages/core/src/engine.ts)、[问答 scope](../packages/contracts/src/index.ts)。

### 5.2 能把诉求写入平台订单的客服

用订单备注 / 标签把聊天中的要求带到订单处理环节，减少客服复制粘贴和交接丢失。人工操作和授权的自动操作共用一个后端命令。

对应 UI 是「订单卡 → 备注 / 标签」，先有可验证订单选择，再允许写入。完整订单查询是这组能力的重要补充项，但不是 botsdk 目前已经写好的接口。

### 5.3 真正的平台客服转接

组合可分配客服列表、平台转接、历史消息和可选的原平台定位，可以按所选客服或已配置的售前 / 售后目标转接，并附处理摘要。外部客服仍是拼多多账号，不要求 JuDesk 引入组织 / 团队系统。

当前 JuDesk 的 `handoffToHuman` 只记录本机 awaitingHuman 并发送固定提示，没有指定客服或调用平台 moveconv。接入后应分开表达「交给本机人工」与「转给平台客服」，平台确认后才显示已转接；失败时保留本机待人工。

转接会改变会话接待归属，应作为本轮终止动作。不要在工具里立刻修改归属后又让原 Agent 继续发送，避免重复之前的 STALE / 错误归属问题。botsdk 识别模块时检查的是 `moveConversation`，实际调用写的是 `moveconv`，迁移时需在当前账号页面核对实际方法与回执。

依据：[MoveConv](../../botsdk/PddWorkbench/Windows/MainWindow.axaml.cs)、[handoffToHuman](../packages/ai/src/index.ts)、[finishAgentHandoff](../packages/core/src/engine.ts)。

### 5.4 视频教程式客服

组合素材列表与视频发送，让人工或 Agent 发送安装、使用、排障视频。视频应落在会话里的素材选择器，不必新增主导航。

现有 SendCommand、IncomingMessage 与问答类型没有视频，需补视频消息格式、素材元数据、渲染和确认发送。botsdk 只有发送已有 URL 和列出素材；视频上传、视频理解、视频问答知识类型都不能算现成能力。

依据：[视频查询 / 发送](../../botsdk/PddWorkbench/Windows/MainWindow.axaml.cs)、[消息与问答契约](../packages/contracts/src/index.ts)。

### 5.5 与平台同步的日常接待

平台会话列表 + 历史分页用于补齐首次接入上下文，markread 用于同步未读，selectconv 用于快速定位原平台，客服状态用于明确在线 / 忙碌 / 离线，typing 用于告知买家正在处理。

这些多属于工作台自动协调和人工操作，未必应变成 Agent 工具。接入后仍需区分历史导入和实时消息，不重放旧自动回复；列表与历史接口存在也不代表已经具有完整的断线期间消息恢复能力。

## 6. 哪些能力不能计入“集成所有现有接口”

botsdk 的网页模块探测检查了：

- `ordersAll`、`unpaidOrders`：订单查询方向的线索。
- `updateUserRemark`、`addOrderNote`：客户 / 订单备注方向的线索。
- `littlePayApply`、`sendLittlePayCard`：小额补偿方向的线索。
- `updatePrice`：订单价格操作方向的线索。
- `closeConversation`、`markConversation`、`unmarkConversation`、`getLatestConversation` 等会话函数。

这些是函数名出现与函数类型检查，缺少这里的业务参数、返回校验、完整调用路径和错误处理，不能直接宣布能查订单、自动改价或赔付。当前仓库也没有找到物流轨迹、修改地址、退款处理、发券的完整处理方法。

因此全量移植现有已封装能力，可以得到商品咨询、平台转接、视频答疑、订单备注和接待同步的增强；它还不是完整的订单 / 物流 / 售后运营系统。后者需要额外调研和实现。

此外，botsdk 的图片发送脚本直接引用 uid，却没有像 SendText 那样将 uid 序列化进生成脚本；多数 HTTP 方法只返回原始内容。这些都说明参考项目适合提供调用线索，不适合当作已经验证完的通用 SDK 逐行复制。

依据：[模块特征检查、SendImage 与 HTTP 方法](../../botsdk/PddWorkbench/Windows/MainWindow.axaml.cs)、[空 GetOneGoodAsync](../../botsdk/PddWorkbench/AI/Tools/MallTool.cs)、[请求参数 DTO](../../botsdk/PddWorkbench/Dtos/WebSocketParam.cs)。

## 7. 与现有 Agent / Toolkit / Workflow / Skill 的衔接

建议沿用本地架构，把新增能力分在四层：

1. **拼多多适配层**：维护登录会话、固定请求路径、参数映射、账号能力和平台返回校验。Cookie / AntiContent 留在这一层；不把任意 URL 或任意网页脚本作为 Agent 接口。
2. **业务层**：只读查询绑定本店 / 当前买家；备注、发视频通过独立命令记录状态、目标、前后值和平台结果。账号、会话及配置变化时重新检查，未知结果不盲目重试。
3. **高级扩展层**：Toolkit 提供明确工具，Agent 可以直接调用；用户可按需使用 Workflow 组织多步骤，但这不是使用新增工具的前提。Skill 描述店铺处理规则和备注格式，脚本用于格式转换等计算，业务写操作仍走受控工具。
4. **配置与界面**：只沿用现有 Toolkit 挂载与发布入口，不新增商品、订单、视频管理页，不做平台真实转接。原始执行明细继续留在开发者「诊断与日志」；视频工具后续如实现，只补必要的消息显示与发送状态。

当前 `ScopedAssetContext.platform` 只有 query，host 又只允许三个操作，因此现在仅写一个自定义 Toolkit / Skill 并不能通过受控接口改订单备注。需要新增明确的操作契约和能力开关，而不是将 orders 从 false 改 true 就算完成。平台支持与店铺授权也应分别记录；学习候选仍必须人工审批，不把新的业务工具开放给学习 Agent 执行。

为控制模型用量，接口本身不额外触发模型；能够确定性完成的检查、备注格式化和结果提示用本地代码处理。若采用 Agent 工具循环，查询结果返回给模型后继续推理通常会产生后续模型请求，应按需调用、限制返回字段和使用短时缓存，不能承诺补齐所有工具后每轮仍只有一次模型请求。不要增加专门的“格式修复”模型调用。

依据：[扩展上下文](../packages/extension-sdk/src/index.ts)、[工具能力与会话约束](../packages/ai/src/index.ts)、[发送记录](../packages/database/prisma/schema.prisma)、[平台架构约定](platform-adapters.md)。

## 8. 自动学习需要一起补的证据能力

当前平台工具查询会生成临时 evidenceId，但工具返回的完整可验证事实未持久化；学习证据目录只接受已有消息与知识修订，无法查实的临时引用会被排除。这与此前修复的“学习引用不存在证据”直接相关。

如果 Agent 依据 SKU、足迹或订单备注结果回答，后续学习需要读取当时的实际资料，而不是拿现在变化后的库存或备注来评判过去的回答。建议新增平台证据快照：记录账号 / 店铺 / 会话、查询对象、工具版本、时间和经过筛选的返回字段，并纳入学习的真实证据清单。

动态库存、客户订单备注、个人收货要求通常不是可供所有买家复用的问答答案。学习应提取稳定的产品知识或服务流程；实例相关事实保持订单 / 会话范围，任何知识新增与修改仍走人工审批。

依据：[临时平台 evidenceId](../packages/ai/src/index.ts)、[学习证据白名单](../packages/core/src/learning-evidence.ts)。

## 9. 修订后的 Toolkit 落地次序

| 优先级 | 范围 | 交付边界 |
| --- | --- | --- |
| 首批 | `goods`、`goods-detail`（聚合详情与属性）、`goods-skus`、`buyer-footprint`、`history` | 扩展现有拼多多 Toolkit，让回复 Agent 按需查询；绑定当前店铺 / 买家，返回精简、可追溯的资料 |
| 紧接首批 | 订单备注工具与必要的最小订单上下文读取 | 以工具完成备注 / 标签更新，不建设订单管理页；没有可验证订单或旧备注时不宣称已完成备注 |
| 后续可选 | 视频素材查询与回复视频工具 | 成套补发送协议、消息渲染与回执后再挂给 Agent；不新增视频管理页 |
| 本轮排除 | 平台客服列表、真实转接 | 用户明确不需要；保留现有本机转人工 |
| 留在宿主，暂不扩展 | 平台已读、客服在线状态、typing、原平台定位、全局账号 / 会话状态、Cookie / AntiContent | 不交给 Agent 决策，不因 Toolkit 封装扩张 UI 范围 |
| 另行调研 | 订单详情 / 物流、改地址、退款、赔付、改价、发券 | 现有代码不足以封装为可用业务工具，不作为本批交付 |

实现时检查查询范围、结构化输出、时间与证据快照、备注覆盖语义和未知结果。工具实现本身不调用额外的审核或格式修复模型；必要的 Agent 工具循环用量单独记录。学习建议仍须人工审批。
