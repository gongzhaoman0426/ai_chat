# 免费软件、Pro 与云端 AI

句达的接待、全部平台与店铺、问答库、自动学习、Agent、Skill、Toolkit、Workflow 和开发者工具均免费，不要求设备激活或店铺授权。

AI 来源有两种：

1. **云端 AI（免费账号即可）**：注册 / 登录后选用句达提供的模型，按 Token 用量从余额扣费。
2. **自有 API Key（需句达 Pro）**：填写自己的 Base URL 与密钥，费用由该模型服务商结算。

未配置云端服务地址的安装包（自托管 / 本地开发）仍可直接使用自有 Key，便于测试。

## Pro 套餐

Pro 由配套 `judesk-license` 管理。管理员在后台「软件套餐」中调整名称、天数、价格（分）和是否上架；默认种子为 30 天 / ¥99，可随时修改。新价格只影响之后创建的订单。

用户在桌面「云端 AI」登录后可购买或续费 Pro。支付成功后账号 `proExpiresAt` 按购买天数累加；有效期内 `features.byok = true`，桌面才允许保存与调用自有模型配置。管理员也可在用户详情中「赠送 Pro」。

公开目录：

```http
GET /api/catalog
```

返回 `byokRequiresPro`、`paymentEnabled` 与可售 `plans`。登录后 `GET /api/me` 含 `subscription.plan` / `proExpiresAt` / `features.byok`。

## 云端 AI 计价

管理员在「云端 AI」配置上游 OpenAI 兼容接口、API Key、模型、输入 / 输出成本价和盈利倍率。费用统一以人民币计价：

`用户费用 = (输入 Token × 输入成本价 + 输出 Token × 输出成本价) ÷ 1,000,000 × 盈利倍率`

例如输入成本 2 元 / 百万 Token、输出成本 8 元 / 百万 Token，倍率 1.5 时，用户单价分别为 3 元和 12 元 / 百万 Token。按每次请求实际返回的用量结算。

## 桌面接入

开发环境：

```sh
JUDESK_LICENSE_CONFIG=../judesk-license/.local/license.json pnpm dev
```

发行包可放置 `resources/license.json`：

```json
{ "serverUrl": "https://admin.quantaflow.one" }
```

不要把上游密钥、虎皮椒 APPSECRET 或其他服务端密钥放入该文件。

## 迁移与验证

服务端保存上游、云端模型、余额、用量、账本、虎皮椒充值订单，以及 Pro 套餐与套餐订单。桌面充值与购买 Pro 均走 license 后端微信支付二维码，每 5 秒查询订单结果。

```sh
pnpm test
pnpm build
node scripts/free-cloud-smoke.mjs
```

桌面冒烟使用隔离数据目录和本机模拟云端，不连接真实店铺，也不发生真实收费。真实上游、虎皮椒商户和生产数据库迁移需在上线环境另行验证。
