# 企业微信群半自动抓取脚本

这个脚本按“安全优先版”设计：

- 只复用你手动扫码登录后的网页会话
- 不绕过登录，不调用企业微信底层协议
- 不自动发消息，不自动点开其他群
- 默认只预览识别结果，不自动提交
- 文字优先：自动把同一用户在时间窗口内的连续消息归并成一段会话，再拆解出多个独立需求
- 截图可选：截图不再强制，纯文字也能提交分析
- 正式提交时，会把归并后的原话、来源信息（和截图，如有）送进平台，由平台侧 GPT 做最终结构化分析

## 第一次使用

1. 确认本地后台已经启动在 `http://127.0.0.1:3001`
2. 确认 `.env.local` 已经有 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`
3. 安装浏览器内核：

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem npx playwright install chromium
```

## 可选环境变量

可以把这些配置放进 `.env.local`：

```bash
WECHAT_WORKBENCH_URL=https://www.xunjinet.com.cn/app/quan-msgv2/
TARGET_GROUP_NAME=🍉文案
FEEDBACK_API_URL=http://127.0.0.1:3001/api/feedback
OPERATOR_NAME=青柠
DRY_RUN=true
REQUIRE_CONFIRM=true
POLL_INTERVAL_MS=300000
MAX_SCAN_MESSAGES=80
CLASSIFY_BATCH_SIZE=10
SESSION_GAP_MINUTES=10
```

说明：

- `DRY_RUN=true`：只预览识别结果，不提交到本地后台
- `DRY_RUN=false`：允许提交到本地后台
- `REQUIRE_CONFIRM=true`：每一轮提交前都需要你在终端手动确认
- `SESSION_GAP_MINUTES=10`：同一用户消息间隔超过 10 分钟就拆分为不同会话

## 最安全的启动方式

```bash
npm run wechat:capture
```

脚本启动后：

1. 会打开浏览器
2. 你手动扫码登录
3. 你手动打开目标群聊
4. 回到终端按一次 Enter
5. 脚本开始每 5 分钟扫描一次当前页面

## 什么时候再切到自动提交

等你确认识别结果稳定后，再用：

```bash
npm run wechat:capture:submit
```

即使是提交模式，也仍然会先让你在终端输入确认。

提交模式的实际链路是：

1. 抓取脚本把同一用户在时间窗口内的连续消息归并为一段会话
2. AI 判断每段会话是否包含需求，并拆解出所有独立需求
3. 对每个需求，把归并后的原话、时间、来源群、发送者上传到 `POST /api/feedback`（截图可选附带）
4. 平台后端再调用统一的 AI 分析逻辑，生成分类、详细说明和 `essenceKey`

## 本地运行数据

脚本只会在项目下生成本地运行文件：

- `.runtime/wechat-capture/profile`：浏览器登录缓存
- `.runtime/wechat-capture/screenshots`：局部截图
- `.runtime/wechat-capture/state.json`：已处理消息去重状态

如果你想重新从头扫描，可以删除：

```bash
.runtime/wechat-capture/state.json
```
