# 快手接入与客服工具

版本：v0.1  
日期：2026-09-11

## 接入方式

快手商家客服入口是 `https://im.kwaixiaodian.com/`。商家壳页面会创建同源隐藏的 `/workbench/chat-sdk` iframe，IM SDK 和 Webpack runtime 位于该 iframe 中。JuDesk 使用独立 Electron session 分区保存登录态，由主进程管理页面；页面桥接只扫描商家主页面和这个已知同源 iframe，不开放任意脚本执行。

登录身份通过快手登录接口读取 `shopId`、`userId`、店铺名和客服名。身份识别与 IM SDK 就绪分开判断：识别成功会登记店铺，只有 SDK 就绪、实时连接和发送回执能力都确认后，账号才进入可接待状态。

## 已接入能力

| 能力 | 目前实现 | 说明 |
| --- | --- | --- |
| 店铺登录 | 已实现 | 独立 session 分区；失效页自动跳转官方登录页 |
| 实时消息 | 已实现 | `messagesUpdate` 监听、买家/客服方向识别、消息去重和主进程 ACK |
| 文本消息 | 已实现 | `getKwaiMsgConstructor(0)`，等待精确 `msgId` 回执 |
| 图片消息 | 已实现 | `ks://` 资源转 HTTPS；接收和发送均限制图片来源、类型和大小 |
| 历史与已读 | 已实现 | `loadMessages` 游标分页，`openSession` 校验 `0_<buyerId>` 会话 |
| 买家资料 | 已实现 | 使用当前会话买家 ID 查询，不跨会话接受资料 |
| 买家订单 | 已实现 | 快手订单接口；支持按商品名称搜索，订单号按字符串保存 |
| 全店商品列表 | 已实现 | `getGoodsListNew`，`viewTab=1`（全部商品） |
| 买家浏览足迹 | 已实现 | 同一接口 `viewTab=2`（浏览足迹）；原生默认 Tab |
| 热销商品 | 接口可用未单独暴露 | 同一接口 `viewTab=3`；可按需再挂操作 |
| 商品卡片 | 已实现 | `preSendCommodity` + `sendCommodityMsg`（contentType `2000`） |
| 发货、退款 | 未开放 | 当前参考代码没有经过足够的真实权限和回执验证 |

## 全店商品与商品卡片

运行时通过商家页 IM SDK 调用（已在真实登录分区验收）：

| 能力 | 路径 / 方法 | 关键参数 |
| --- | --- | --- |
| 商品列表 | `POST /gateway/business/cs/list/item/info`（`getGoodsListNew`） | `buyerId`、`limit`、`offset`、`viewTab`（常用 `1`）、`searchKeyword` |
| 卡片预发 | `POST /rest/app/tts/cs/card/preSendCommodity` | `targetId`（买家）、`commodityId`（商品） |
| 卡片发送 | `messageSender.sendCommodityMsg({ targetType:0, targetId, extra, content }, dry?)` | `content` 为 `preCommodity` 与其 `commodity` 合并；`dry=true` 时仅构造，由桥接统一 `sendMessage`+回执 |

探路笔记：[references/kuaishou-goods-console.js](references/kuaishou-goods-console.js)。列表项字段含 `itemId`、`title`、`imageUrls`、`minPrice`/`maxPrice`（分）。

## Toolkit 路由

快手不创建独立的 PDD/快手 Toolkit。所有平台能力继续挂在统一「店铺客服工具」下，当前店铺和登录账号由宿主绑定。`CommerceService` 只把当前账号声明为已就绪的操作交给 Agent；模型不能传入其他店铺、账号或买家 ID 替换作用域。快手当前向 Agent 暴露买家资料、历史、订单、**全店商品**、**浏览足迹**、客服组和客服状态查询，以及 **发送商品卡片**；客服组转接仍走受控操作接口。

## 工作台

右侧工作台按当前会话绑定店铺、账号和买家，提供客户资料、订单、历史消息、客服状态和转接操作。查询返回缺失列表或业务失败时显示明确错误，不把失败当成空结果；订单金额和订单号保持平台原始精度。所有写操作都在主进程再次核对账号、店铺、会话和当前连接状态。

## 验收边界

自动化测试覆盖 SDK 缺席、iframe 发现、SDK 重载、消息去重、发送回执、历史分页、订单结构、客服转接、Toolkit 能力过滤和登录跳转。测试使用脱敏 fixture，不等同于真实店铺验收。发布前仍需用真实快手账号验证登录识别、买家消息、人工文本发送、图片、订单、转接和断线恢复；页面 SDK 结构变化时应进入等待/降级状态，不猜测接口。
