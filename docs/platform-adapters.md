# 平台接入设计

> Workflow 扩展已移除，本文中与 Workflow 相关的内容仅为历史记录，见[本地扩展开发](extension-development.md#workflow-已移除)。

版本：v0.7

方案日期：2026-09-09

状态：已提供拼多多、抖店、闲鱼与快手适配实现；实际交付、验证证据与待实测项见[实现与验证记录](implementation-status.md)。

2026-09-08 补充：[抖店接入与多店铺工具路由](douyin-integration.md)。共享宿主生命周期，平台实现独立；Agent 工具按当前店铺装配。

2026-09-09 补充：[闲鱼接入与客服工具](goofish-integration.md)。接入文本/图片、历史、商品与关联订单；无需物流发货采用提交前核验和结果读回，真实账号验收边界单独记录。

2026-09-11 补充：[快手接入与客服工具](kuaishou-integration.md)。快手商家页把 IM SDK 放在同源隐藏 `/workbench/chat-sdk` iframe；桥接同时扫描主页面与该 iframe，提供账号识别、文本/图片收发、回执、历史、订单、客服和客服组能力。

## 1. 目标与接入现状

平台层统一提供账号连接、消息接收、消息发送、结果确认和必要业务查询。业务层与 AI 模块使用统一接口，具体页面、协议字段、鉴权和限流留在对应适配器。

接入层还必须提供形成问答回合所需的实际回答事件，使后台学习循环可以覆盖 AI 回答及人工作答。问答库原文直答仍要同步为会话消息，但不单独进入学习。回答观测独立于本机自动回复开关；原平台人工发送也需要同步。

| 平台 | 当前依据 | 第一轮验证目标 |
| --- | --- | --- |
| 拼多多 | 相邻 `botsdk` 项目存在内嵌网页、脚本桥接及会话 Cookie 请求的参考代码 | 登录身份、多账号隔离、稳定消息标识、文字收发与回执 |
| 快手 | `ks_demo.js` / `ks_inject.js`；已实现官方商家页、隐藏 chat-sdk iframe、消息/回执、历史/订单/客服组查询与转接 | 真实账号登录识别、双向收发、图片、订单和转接验收；页面 SDK 变化需降级 |
| 闲鱼 | `xy_inject.js` / `xy_demo.js` 与当前官网 SDK；已实现账号、桥接、文本/图片、回执与限定业务工具 | 真实账号收发、图片权限、订单结构与无需物流发货读回；当前仅接待可核实卖家身份的商品单聊 |
| 抖店 | 飞鸽探路笔记与当前公开 SDK；已实现账号、桥接、消息/回执和限定查询 | 真实账号权限和买家端收发验收；完整断线缺口补拉尚未实现 |

参考代码中的方法名称和官方门户中出现的能力描述都不等于当前账号拥有对应权限。第一轮调研必须使用实际测试账号记录结果，不依据非官方文章推断已经支持。

## 2. 通道选择原则

优先验证适用账号可获得的正式接口及消息通道，再评估登录网页的集成方式。每个平台单独记录接入依据、权限、协议版本和限制。

| 通道 | 执行位置 | 本地方案的前提 |
| --- | --- | --- |
| 客户端主动建立的长连接或轮询 API | 业务进程 | 鉴权适用于桌面客户端，账号具有所需读写权限 |
| 登录后的网页集成 | 主进程管理 WebContentsView，适配器调用 BrowserHost | 登录、事件桥接、发送确认、后台存活均通过实测 |
| 需要公网回调的接口 | 新增回调接收端，桌面主动连接接收端 | 原有完全零后端假设需要调整 |
| 需要服务端保密的共享凭据 | 新增相应服务 | 不在安装包内置保密凭据作为长期方案 |

不将开启网页 Node.js 权限、关闭同源限制或伪装成任意平台通道作为通用解决办法。页面集成不得通过宽泛的执行接口暴露本地系统能力。

## 3. 适配接口

下面是 JuDesk 自定义的 TypeScript 契约草案，不代表任何平台官方 SDK 的方法名称。正式实现需补充对应 Zod schema。

```ts
type Platform = 'pinduoduo' | 'kuaishou' | 'goofish' | 'douyin';

type AccountScope = Readonly<{
  platform: Platform;
  storeId: string;
  accountId: string;
  sessionGeneration: number;
}>;

type Capabilities = Readonly<{
  transport: 'browser' | 'api' | 'hybrid';
  receiveRealtime: boolean;
  fetchHistory: boolean;
  observeHumanReplies: boolean;
  sendText: boolean;
  sendImage: boolean;
  nativeIdempotency: boolean;
  reconcileSend: boolean;
  readGoods: boolean;
  transferConversation: boolean;
  limits: { maxTextLength?: number; maxAttachmentBytes?: number };
}>;

type PlatformEvent = {
  schemaVersion: 1;
  eventId: string;
  externalEventKey: string;
  scope: AccountScope;
  kind: 'message.received' | 'message.sent' | 'message.updated'
    | 'message.retracted' | 'session.changed' | 'receipt.received';
  receivedAt: string;
  payload: unknown; // 正式实现中按 kind 使用具体判别联合类型
};

type SendCommand = {
  intentId: string;
  executionToken: string;
  scope: AccountScope;
  externalConversationKey: string;
  routingEpoch: number;
  type: 'text' | 'image';
  text?: string;
  attachmentId?: string;
};

type SendResult =
  | {
      status: 'confirmed';
      externalMessageId?: string;
      evidence: 'platform_ack' | 'receipt' | 'history';
      evidenceRef: string;
    }
  | { status: 'rejected'; code: string; retryable: boolean }
  | { status: 'unknown'; reason: string };

interface PlatformAdapter {
  readonly platform: Platform;
  connect(scope: AccountScope): Promise<Capabilities>;
  disconnect(scope: AccountScope): Promise<void>;
  events(scope: AccountScope): AsyncIterable<PlatformEvent>;
  send(command: SendCommand): Promise<SendResult>;
  fetchHistory?(
    scope: AccountScope,
    conversationKey: string,
    cursor?: string,
  ): Promise<{ events: PlatformEvent[]; nextCursor?: string }>;
  reconcileSend?(command: SendCommand): Promise<SendResult>;
}
```

连接时以平台实际身份校验 storeId 与 accountId 的映射；不是调用方提供什么 scope 就接受什么 scope。能力对象反映已登录身份和实际权限，重新登录或权限变化后重新生成。

内部 SendCommand 携带意图 ID，并不代表平台原生支持幂等键。只有平台明确接受并验证过幂等语义，`nativeIdempotency` 才能标记为 true。

可选能力为 false 时，界面和 Agent 工具均不得表现成已经可用。已验收为 true 的能力可封装为内置 Toolkit 集合供回复编排选择；实际工具列表还受 Agent / 子 Agent 挂载、店铺 / 买家范围和当前接待状态约束。商品、订单、足迹、转接等通过独立的强类型查询 / 操作契约扩展，不增加“调用任意平台接口”的通用入口。

### 3.1 平台能力与 Agent 扩展的关系

平台适配器负责登录、通道、消息规范化和结果确认；Toolkit 负责将经过验收的业务能力封装成带 schema 的 Agent 工具。Agent Studio 选择 Toolkit 不会直接注册新的底层平台协议，也不能将“已安装工具”当作账号权限证明。

| 层次 | 可配置内容 | 调用约束 |
| --- | --- | --- |
| PlatformAdapter | 应用已实现并验收的账号能力 | 由实际登录身份确认，随账号状态变化更新 |
| Toolkit 集合 | Agent 挂载哪些平台工具集合，以及集合的非身份设置 | 只调用强类型宿主接口，不取得 Cookie、BrowserHost 或任意脚本入口 |
| Workflow 成员 | 按步骤组合查询和允许的操作 | 继承当前角色与店铺范围，不能越过发送状态机或知识审批 |

内置默认回复模板可以挂载全部已验收能力；高级用户可缩小工具范围或拆到子 Agent。内置学习 Agent 只能使用评估需要的只读平台能力，不能通过挂载回复工具、子 Agent 或嵌套 Workflow 获得写权限。回复必需的 `handoffToHuman` 属于 JuDesk 接待控制，与平台自身的客服转接能力分别登记。

调用时再次核对当前 accountId、routeVersion、角色配置代次和会话状态；店铺或账号 ID 由宿主绑定，不接受模型或扩展任意替换。发文字、发图片即使由工具 / Workflow 请求，也只能提交统一 OutboundMessage；已确认、确定失败和 unknown 的处理保持一致。扩展接口和版本约定见[Agent 配置与高级扩展](agent-customization.md)。

## 4. 网页宿主与账号隔离

`BrowserHost` 是主进程提供的最小能力接口，负责创建账号页面、执行已登记操作、转发已校验事件和销毁页面。其实现依赖 Electron，平台逻辑不直接依赖全局窗口对象。

分区建议使用 `persist:judesk:<platform>:<accountId>`。账号尚未识别时，先分配本地临时账号 ID，完成登录后绑定实际身份；不能在多个新登录窗口间共用默认 session。

- 工作台 preload 与平台页面 preload 分开，避免第三方页面获得工作台 API。
- 页面 URL、frame 和 webContents ID 必须匹配已登记的账号宿主。
- Cookie、缓存和本地存储留在所属 session。直接 API 与网页混用时明确会话管理方式，避免多个 Cookie 副本失去同步。
- 网页宿主仅接受经业务层授权的操作、参数和执行令牌；不接收 renderer 或模型生成的任意 JavaScript。
- 隐藏页面和切换标签不代表通道停止。后台限流、页面重载与常驻资源使用须在目标系统实测。
- 在页面结构不再匹配时，将账号标记 degraded 并暂停自动发送，不继续猜测 DOM 结构。

参考 [Electron session](https://www.electronjs.org/docs/latest/api/session)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 和[安全建议](https://www.electronjs.org/docs/latest/tutorial/security)。

## 5. 消息规范化

所有消息至少保留：平台、店铺、接收账号、外部会话键、外部消息 ID（若有）、发送者及来源类别、方向、消息类型、规范化正文、附件引用、平台时间、本机接收时间和相关回执。平台具有回复引用、线程关系、编辑版本、撤回标识或请求 ID 时一并保留，用于问题与实际回答的关联。

文本、图片、商品卡片、订单卡片、系统事件分别识别。尚不支持理解的类型在 UI 显示为明确的类型占位或原平台查看入口，不编造文本给模型。

保留有限且脱敏的平台原始结构用于诊断回放，剔除鉴权头、Cookie、临时签名等不必要字段。平台大整数按字符串处理。

平台机器人、人工作答和 JuDesk 自己发出的消息必须尽量可区分。AI 和人工回答提供给学习循环；问答直答只作为已发出的知识原文，不单独评估。来源 unknown 时保留证据并等待分类，不擅自标为人工可靠答案。学习评估可记录不确定性；任何拟新增或修改的知识先进入待审批，人工批准后还需通过来源、范围和版本校验。

### 5.1 回答来源与学习事件

对本机发送，业务记录保存 questionGroupId、replyOrigin、AiRun 和发送意图。适配器上报确认时带回可对应的请求或平台消息标识，由业务服务关联到这些记录。不能仅凭答案文字相同就判定为问答对直答，也不能把 JuDesk AI 在平台上的客服账号回显误判为人工作答。

对原平台人工发送，接入层提供实际消息、发送者、可用的引用关系和时间顺序。它不需要有本机 OutboundMessage，也不要求用户正在 JuDesk 中打开会话，仍能成为学习输入。人工回答同步不切换接待模式，也不打断 AI 回复；暂停与恢复由显式接管、转接客服、交还 AI 和既有 AI 转人工规则控制。

平台适配器输出事实事件，不直接调用学习 Agent。conversations 模块完成消息去重与问答配对，事务性写入 `turn.answered` / `turn.revised` / `turn.invalidated`，LearningLoop 再订阅这些业务事件。

同一消息的 ack、页面回显、长连接推送和历史补拉需要归并，不能各触发一次独立知识沉淀。实际回答尚未确认、消息引用不清或历史断档时保留状态，不能伪造完整问答。

回答补充、编辑、撤回和人工纠正必须保留原关联，供 sourceRevision 更新和知识复核。平台不提供这些事件时，记录能力限制，不能声称实时发现了所有错误答案。

## 6. 登录、连接与恢复状态

账号状态包括：disconnected、connecting、needs_login、verifying、online、recovering、degraded、paused。

- 页面打开后进入 verifying，完成身份与能力核验才能 online。
- 会话失效进入 needs_login，暂停该账号的新发送。
- 网络恢复进入 recovering，完成游标补拉与接待归属检查后再恢复自动接待。
- 通道结构变化、无法判定消息方向或回执语义时进入 degraded。
- 用户主动关闭自动接待或暂停账号时进入相应业务暂停状态，不能被自动重连覆盖。

历史补拉使用已提交游标，并保留重叠窗口，通过稳定消息键去重。平台不支持补拉或存在历史窗口限制时，将无法恢复的区间标记为断档，等待人工检查。

仅凭平台心跳连通不足以证明客服收发正常；健康检查至少覆盖登录身份、接收通道状态和最近一次能力验证结果。

### 6.1 移除账号后的会话恢复

移除账号会保留历史会话和问答。重新登录同一平台、同一店铺会复用 Store，但新 Account 的本地 ID 可能不同，不能继续使用旧 Conversation.accountId 发送。

- 移除账号在同一事务中递增相关会话的 routeVersion / revision，取消尚未执行的回复任务及所有 prepared 消息（包括人工消息），然后删除账号与自动重连设置。主进程连接清理在事务外完成，避免连接状态回调等待同一把锁。
- 账号登记或通道恢复在线时，只修复原账号已经不存在的会话。店铺只有一个本地账号且在线时，自动绑定该账号；人工发送准备阶段也执行相同检查，兼容旧版本留下的悬空引用，无需等待买家再发一条消息。
- 账号候选严格限于同一 Store，不跨平台或跨店铺。已有账号即使离线也保留归属。同店多个账号时（包括离线账号），不按上线顺序或随意选择账号；通过已校验身份账号收到的、新产生的非系统消息恢复悬空归属，历史补拉与重复回显不决定归属。无法确定时人工发送返回明确的连接或绑定提示。
- 恢复归属再次递增路由和会话版本，取消旧路由的未发送任务，记录 conversation.route_recovered；保留原店铺、买家、外部会话键及平台上下文。不会重新启用旧问题的自动接待资格。
- dispatch 再次检查账号存在、店铺一致、路由版本一致及在线状态，异常保存为明确的取消原因。dispatching、unknown、已失败和已确认的消息始终保留原发送账号及回执，不自动换账号重发；迟到的确定回执仍归档到原发送记录。

## 7. 发送与确认语义

适配器必须遵守[发送状态机](data-design.md)。执行页面脚本成功、按钮被点击、HTTP 请求返回 200，只有在对应平台协议明确表示消息被接受时才可映射为 confirmed。

需要记录确认依据：平台 ack、可对应的发送回执，或含稳定标识的历史记录。模糊的“正文相同且时间接近”默认不足以自动消除 unknown，因为真实的多条消息可能内容相同。

重启后复核 `dispatching` 和 `unknown` 的发送，不能因为 UI 缓存清空就重发。取消操作仅能阻止尚未提交的平台发送，不能保证撤销已在途消息。

## 8. 每个平台的验收矩阵

| 验收项 | 通过证据 |
| --- | --- |
| 账号身份 | 能区分店铺与客服账号，错误身份绑定被拒绝 |
| 多账号隔离 | 同时登录两个账号，Cookie 与消息不会串号 |
| 消息标识 | 确认会话/消息 ID 的唯一范围，重复投递可归并 |
| 消息类型 | 文本与必要卡片解析正确，未知类型不会被错误当成买家问题 |
| 学习回合 | 买家问题与真实文字 / 图片回答能关联；三类来源、人工追加 / 纠正与撤回信息可追踪 |
| 来源与回显 | 本机直答 / AI / 人工发送与平台回显只形成一条回答；原平台人工发送不会被漏掉 |
| 文字发送 | 对测试会话发送并获得明确的确认依据 |
| 结果不明 | 中断响应后不会自动重复发送，能确认或显示待确认 |
| 人工接待 | 查看、人工发送及普通业务操作不暂停 AI；显式接管或转接客服后暂停，AI 主动转人工规则保留，显式交还 AI 后只接待新消息；原平台人工作答能被观察或明确标示限制 |
| 断线与重启 | 恢复身份、游标与未完成发送，确认历史补拉范围 |
| 后台运行 | 页面隐藏、窗口最小化和托盘驻留后仍符合预期 |
| 权限与限流 | 记录实际权限、错误码、退避条件和平台相关限制 |
| 安装包 | 在目标系统的真实安装包中复现完整收发流程 |

未通过人工回复观测、去重或结果确认的通道，首版保留聚合查看和人工发送，不开放自动回复开关。

能力验证记录应包含日期、适配器版本、系统架构、账号类型、已验证权限、样本与限制说明。通过测试账号验证也不能推断其他账号类型拥有相同权限。

## 9. 拼多多首轮实现范围

第一轮只覆盖账号登录与识别、文本消息接收、统一会话列表、人工文字发送、回执确认、原平台人工作答观测、问答关联所需标识和断线恢复。验证完成后再接自动回复开关、商品查询与图片能力。

`botsdk` 中的 Webpack/Vue 模块发现和 Cookie 请求逻辑可以用于理解问题，但其中的未完成接口、页面耦合、无鉴权的本地 WebSocket 和发送缺陷不作为 JuDesk 实现模板直接复制。


## 2026-09-08 已实现：PDD Toolkit v2

固定桥接脚本 v16 和 PddHost 现支持商品、详情 / 属性、SKU、当前买家关联商品、历史、当前买家订单查询。能力字段 goods / history / orders 表示在线通道具备相应适配器；orderRemark 为新增可选能力字段，旧账号快照缺失时不会暴露备注工具。登录身份与通道在请求前后复核，具体接口权限与业务返回在调用时判断；这不表示启动时已经验证每个业务接口。

订单备注单独走 executeAction，与 query 分离：服务解析受限引用，宿主重查买家订单、读取旧备注及标签、读写前比较、回调服务授权、提交后读回核对。写入结果未知时本机转人工，不重试。仅此受限订单操作已实现，平台真实客服转接和视频仍未接入。见 [工具箱契约及限制](pdd-toolkit-plan.md)。
