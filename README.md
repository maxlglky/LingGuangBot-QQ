# x2qq

> 把 X（Twitter）账号的推文自动搬到 QQ 群 / QQ 私聊，长得像 QQ 自带的推文卡片。

<p align="left">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-success.svg">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg">
</p>

关注某个账号，但不想一直盯着 X？x2qq 会在 5 分钟内把新推文转进你的 QQ 群：
头像、蓝 V、正文、配图、引用、转推、视频、时间、原帖链接，一样不少。

- **零依赖**：只用 Node.js 内置模块，clone 下来就能跑，不需要 `npm install`
- **零第三方服务**：用你自己账号的 cookie 直连 X 的 GraphQL，不需要 RSS 服务、不需要付费 API
- **会听指令**：群成员可以 `/订阅`、`/退订`、`/翻译 开`、`/回复 aimi 关`……
- **群聊和私聊都支持**

---

## 目录

- [效果](#效果)
- [部署（只用不管代码）](#部署只用不管代码)
  - [前置条件](#前置条件)
  - [五步跑起来](#五步跑起来)
  - [拿 X cookie](#拿-x-cookie)
  - [常驻与开机自启](#常驻与开机自启)
  - [上线检查清单](#上线检查清单)
- [配置说明](#配置说明)
- [群指令](#群指令)
- [命令行工具](#命令行工具)
- [开发（改代码的人）](#开发改代码的人)
  - [目录结构](#目录结构)
  - [一次推送的完整流程](#一次推送的完整流程)
  - [想改某个地方](#想改某个地方)
  - [测试与调试技巧](#测试与调试技巧)
- [设计取舍](#设计取舍)
- [FAQ / 排错](#faq--排错)
- [合规与免责](#合规与免责)
- [License](#license)

---

## 效果

```
## **⇄ 前島亜美_Official 已转帖**
> 转帖于 2026-10-28 14:38

# ![头像] **前島亜美_Official** ![认证]

“前岛亚美 AMILAB” 直播活动公布🧪🥼✨️

日期：2027年1月24日（星期日）

![配图 #600px #450px](…)

> ## 原推账号
>
> 原推正文……
>
> 2026-10-27 21:46｜[查看原帖 ↗](…)

由X自动翻译
2026-10-28 20:06｜[查看原帖 ↗](…)
```

层级约定：主推账号名是 `#`（最大 + 加粗）、转推横幅与引用作者是 `##`、正文用 `>` 缩进表示「引用的内容」。

---

## 部署（只用不管代码）

### 前置条件

| 需要 | 说明 |
| --- | --- |
| Node.js **22+** | <https://nodejs.org/>，装 LTS 即可 |
| QQ 机器人 | 在 [q.qq.com](https://q.qq.com/) 创建，拿到 `AppID` / `AppSecret` |
| 能访问 X 的网络 | 国内需自备代理（下文用 `127.0.0.1:17899` 举例） |
| X 账号 cookie | 建议用小号，见[下一节](#拿-x-cookie) |

> 机器人能力：群里要能「被 @」并能发消息。首次上线前，群主还需在手机 QQ 里给机器人打开
> 「**主动推送消息**」权限，否则会报 `40034105 主动消息失败, 无权限`。

### 五步跑起来

```bash
# 1. 拿到代码
git clone <repo-url> x2qq && cd x2qq

# 2. 生成配置
cp config.example.json config.json      # Windows: copy config.example.json config.json

# 3. 填两处内容（用编辑器打开 config.json）
#    qq.appId / qq.appSecret  ->  QQ 机器人后台的凭据
#    net.xCookie              ->  你的 X cookie（见下节）
#    net.proxy                ->  你的代理地址，直连可留空

# 4. 自检
node src/main.js doctor        # 凭据 / 推文源 / 会话名单
node src/main.js xprobe        # 打印每个账号最新的 3 条推文

# 5. 常驻
node src/main.js run           # 或 Windows 双击 start.cmd
```

看到类似输出就成功了：

```
[1/4] 检查 QQ 凭据 ... OK
[2/4] 检查推文源 ... OK，拿到 2 条候选推文
[3/4] 检查群名单 ... OK，1 个群
基础检查通过。
开始轮询 1 个账号，间隔 300s（随机抖动 0~60s）
```

然后把机器人拉进群，在群里 **@ 机器人** 发 `/订阅 <账号key>`，它就会先推一条该账号的最新推文作为确认。

### 拿 X cookie

1. 浏览器登录 <https://x.com>（建议小号）
2. `F12` → **Application** → **Cookies** → `https://x.com`
3. 复制 **`auth_token`** 的值，顺手复制 **`ct0`**（更稳）
4. 填成一行：

```json
"net": { "xCookie": "auth_token=xxxxxxxx; ct0=yyyyyyyy" }
```

验证：

```bash
node src/main.js xprobe
```

```
cookie: auth_token 已读取 + ct0
queryId: UserTweets=… UserByScreenName=…
[yuna] 拉到 20 条，最新 3 条：
  2026-10-28T13:37:00.000Z  https://x.com/…
```

> cookie 会过期（几周~几个月）。过期后日志会出现 `X 拒绝了请求（401）`，重新复制一次即可。

### 常驻与开机自启

| 方式 | 说明 |
| --- | --- |
| `node src/main.js run` | 一直占着终端，`Ctrl+C` 停止 |
| `start.cmd`（Windows） | 带窗口，关窗即停；node 崩溃 5 秒后自动重启 |
| `stop.cmd`（Windows） | 按 PID 停止，并写 `.stop` 标记防止被自动重启拉起 |
| `autostart.vbs` | 静默启动；丢进「启动」文件夹即可登录自启 |

用本地代理下载 X 媒体（可选）：

```bat
set CLASH_EXE=C:\path\to\clash.exe
node scripts\prepare-local-proxy.mjs C:\path\to\profile.yml 17899
rem 之后 start.cmd 会自动拉起这个「只监听本机」的代理
```

### 上线检查清单

- [ ] `node src/main.js doctor` 四项全绿
- [ ] `node src/main.js xprobe` 能拿到最新推文
- [ ] 群里 `/订阅` 有回复，且收到一条最新推文
- [ ] 群主已开启「主动推送消息」
- [ ] 日志 `logs/run-日期.log` 里每 5 分钟有「本轮结束」记录
- [ ] 重启一次服务，历史推文不会被重复推送（`state.json` 记着已读）

---

## 配置说明

`config.json`（参考 `config.example.json`）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |
| `stateFile` | `state.json` | 运行状态：会话、已读、开关、健康数据 |
| `qq.appId` / `qq.appSecret` | — | QQ 机器人凭据 |
| `qq.apiBase` | `https://api.bot.qq.com` | OpenAPI 地址 |
| `qq.tokenBase` | `https://bots.qq.com` | 换 access_token 的地址 |
| `net.proxy` | — | 拉 X / 下载媒体用的代理；直连留空 |
| `net.xCookie` | — | `auth_token=…; ct0=…` |
| `x.maxAgeHours` | `24` | 只处理这么多小时内的推文 |
| `x.includeReplies` | 按账号配置 | 账号级「回复」总闸（示例里为 `true`） |
| `x.includeRetweets` | 按账号配置 | 账号级「转推」总闸（示例里为 `true`） |
| `forward.intervalSec` | `300` | 基础轮询间隔 |
| `forward.intervalJitterSec` | `60` | 每轮额外随机 `+0~N` 秒，降低风控概率 |
| `forward.accountStaggerSec` | `3` | 同一轮里账号之间随机错开 |
| `forward.maxPerRun` | `5` | 每轮最多推几条 |
| `forward.maxPushAgeHours` | `6` | 超过这个小时数的推文不再补发（`0` 关闭） |
| `forward.maxImages` | `6` | 单条最多内嵌几张图 |
| `forward.maxMarkdownChars` | `4000` | 单条 Markdown 上限 |
| `forward.style` | `markdown` | `markdown` / `text` / `media` / `ark` |
| `forward.markdownImage` | `true` | 图片内嵌进卡片 |
| `forward.perMinute` / `perDay` | `15` / `200` | 每会话发送频率限制 |
| `forward.timeZone` | `Asia/Shanghai` | 卡片时间用的时区 |
| `accounts[]` | — | 账号表，见下 |

单个账号：

```jsonc
{
  "key": "yuna",                        // 群里 /订阅 yuna
  "handle": "yunachan_akb48",
  "displayName": "秋山由奈",
  "provider": "xcookie",                // 目前只有 xcookie / file(调试)
  "userId": "1651920077669945346",      // 数字 ID，留空会自动查
  "includeReplies": true,
  "includeRetweets": true,
  "maxAgeHours": 24
}
```

---

## 群指令

在群里 **@ 机器人**（私聊直接发）：

| 指令 | 作用 |
| --- | --- |
| `/订阅` | 查看本会话订阅状态 |
| `/订阅 <账号>` | 订阅并立刻推一条该账号最新推文 |
| `/退订 <账号>` | 取消订阅 |
| `/最新` | 重发最近缓存的推文 |
| `/翻译 开` / `/翻译 关` | 是否使用 X 自带的中文翻译（正文 + 引用一起翻） |
| `/回复 <账号> 开\|关` | 是否转发该账号的「回复」 |
| `/转贴 <账号> 开\|关` | 是否转发该账号的「转贴」 |

补充说明：

- 机器人被拉进群**只登记、不推送**，必须发 `/订阅` 才开始；
- 订阅时「回复」「转贴」默认开启，之后可以单独关；
- 开关都是**按会话**存的，群 A 关了不影响群 B；
- 私聊会话在 `state.json` 里以 `c2c:` 前缀保存，走 `/v2/users/{openid}/messages`，不需要「主动推送消息」权限。

---

## 命令行工具

```bash
node src/main.js doctor            # 体检：凭据 / 推文源 / 会话名单
node src/main.js run               # 常驻：监听事件 + 轮询 + 推送
node src/main.js once              # 跑一轮
node src/main.js once --dry-run    # 跑一轮但只打印，不发送
node src/main.js once --seed       # 把现有推文全部标记为已读
node src/main.js status            # 健康状态：轮次 / 最后成功 / 连续失败
node src/main.js xprobe            # 验证 X cookie，打印最新推文
node src/main.js groups            # 看已登记会话与订阅关系
node src/main.js groups disable <openid>   # 关掉某个会话的推送
node src/main.js watch             # 只监听事件，自动登记机器人所在的群

# 手动试发（测试样式、排查群权限）
node src/main.js send-test --account <key> --id <推文id> --group <openid>
node src/main.js send-tweet <推文链接> [--group <openid>]
```

---

## 开发（改代码的人）

### 目录结构

```
src/
├─ main.js      CLI 入口 + 指令处理（订阅/退订/翻译/回复/转贴）
├─ poller.js    轮询调度：拉取 → 过滤 → 去重 → 逐群投递
├─ xgraphql.js  X 客户端：cookie、queryId 自动刷新、UserTweets、翻译
├─ tweet.js     推文对象规范化、去重键、行首 @ 剥离
├─ qq.js        QQ OpenAPI：token / 发送 / 素材上传 / 分片上传 / 媒体
├─ gateway.js   WebSocket 网关：群事件 + 私聊事件
├─ format.js    Markdown 卡片渲染（转推 / 回复 / 引用 / 视频提示 / 翻译标记）
├─ fx.js        FxTwitter 详情：引用、真实图片尺寸、视频多档
├─ store.js     state.json：会话、已读、开关、健康状态
├─ http.js      请求封装（代理、超时、大小上限）
├─ commands.js  指令关键词匹配
└─ util.js      日志（控制台 + 按天文件）、时间格式化、原子写

test/pipeline.test.js   端到端单测（mock QQ 服务 + 本地推文源）
assets/verified.png     蓝 V 占位图
scripts/                代理准备、网关探测等开发脚本
```

### 一次推送的完整流程

```
Gateway(WS)                    Poller                       QQ OpenAPI
    │                            │                              │
    │  群消息 / 私聊消息          │                              │
    ├──► main.js onMessage ──► store 修改订阅/开关              │
    │                            │                              │
    │       每 300s + 抖动        │                              │
    │                            ├─ xgraphql: UserTweets        │
    │                            │  (+ UserRepliesTimeline)     │
    │                            ├─ 过滤：时间窗 / 回复 / 转贴    │
    │                            ├─ 去重：x:<id>、原推 id        │
    │                            ├─ fx: 详情（图 / 视频 / 引用） │
    │                            ├─ 翻译（按会话开关）            │
    │                            └──► qq.deliver ────────────────┤ 卡片
    │                                                            ├ 图片(素材)
    │                                                            └ 视频(分片)
```

关键点：

1. **每个账号每轮只拉一次**，产物在内存里复用给所有会话，避免重复请求 X；
2. **哪些内容能推**有三层闸门：账号级（`includeReplies/Retweets`）→ 会话级（`itemFlags`）→ 时间窗（`maxAgeHours` / `maxPushAgeHours`）；
3. **失败不阻塞**：单个会话发送失败只记 `部分失败`，不影响其他会话；翻译失败回落原文。

### 想改某个地方

| 想改 | 去哪 |
| --- | --- |
| 卡片样式（字号、间距、字段顺序） | `src/format.js` 的 `formatTweetMarkdown` |
| 新增一个指令 | `src/main.js` 的 `onMessage`（先 `normalizeCommand`，再分支） |
| 换数据源 | 新增 `src/xxx.js` 导出 `fetchXxx`，在 `src/poller.js` 的 `fetchRaw` 里加 `case`，输出同样的 item 结构即可 |
| 调整过滤/去重 | `src/poller.js` 的 `tickAccount` |
| 会话级开关 | `src/store.js`（`setItemFlag` / `getItemFlags` 是现成模板） |
| 发送行为（限频、媒体） | `src/qq.js` 的 `deliver` |

数据源接口约定：`fetchXxx(cfg, { request, meta, logger, stateFile })` 返回数组，每项形如

```js
{
  id: 'x:123',                      // 去重键
  link: 'https://x.com/u/status/123',
  text: '……',
  published: '2026-10-28T06:38:34.000Z',
  images: ['https://…'],
  isRetweet: false,
  isReply: false,
  replyTo: '',
  replyToStatusId: ''
}
```

之后由 `tweet.js` 的 `toTweet()` 统一成内部结构。

### 测试与调试技巧

```bash
node test/pipeline.test.js          # 11 个用例：渲染、过滤、去重、限频、端到端
node src/main.js once --dry-run     # 真跑一轮但只打印，改样式时最常用
node src/main.js xprobe             # 只验证 X 侧
```

- 单测用 `provider: "file"` + 本地 JSON 推文源，不碰网络；
- 改样式时不要往群里发，先 `--dry-run` 看 markdown，再 `send-test --group <小群>` 验证渲染；
- X 改版导致 `queryId` 失效时，程序会自动重新抓取并写入 `state.json.xgraphql.json`，日志会打印 `已刷新 X 的 GraphQL queryId`。

---

## 设计取舍

**为什么用 cookie 抓 X，而不是 RSS / 第三方 API？**

| 方案 | 延迟 | 成本 | 问题 |
| --- | --- | --- | --- |
| RSS（rss.app 等） | 不可控，实测出现过 **17 小时** | 免费 | 收录延迟、回填旧推 |
| SocialData / twitterapi.io | 秒级 | 按条计费，实测约 **$3.6/天** | 免费额度很快耗尽（402） |
| 公共 RSSHub 实例 | — | — | Twitter 路由已全部关闭（404/503） |
| **X cookie + GraphQL（本方案）** | ≈ 轮询间隔 | 免费 | cookie 会过期，需要小号 |

**为什么卡片里没有视频？** QQ 的 Markdown 不支持视频，所以视频作为独立消息发送，卡片里只给一行提示。

**为什么正文行首要插零宽空格？** QQ 会把行首 `#` 当标题、`>` 当引用，插一个不可见字符即可阻断语法。

---

## FAQ / 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `X 拒绝了请求（401）` | cookie 过期，重新复制 `auth_token` |
| `40034105 主动消息失败, 无权限` | 群主没开「主动推送消息」 |
| 图片发不出来 | 检查代理是否可用；失败会只发文字 |
| 视频没发 | 超过 100MB 会自动降档；看日志 `视频: …` |
| 重复推送 | 转推的转帖 id 与原推 id 已双向标记；若仍出现，检查 `state.json` 是否被并发写 |
| `/订阅` 没反应 | 看日志有没有 `收到指令`；没有则是网关事件没进来（intents / 机器人能力） |
| 服务好像停了 | `node src/main.js status` 看「上次轮询」是否在 10 分钟内 |
| `Cannot access 'norm' before initialization` | 旧版本的已知 bug，更新到最新代码 |
| 日志找不到 | `logs/run-YYYY-MM-DD.log`，按天分文件 |

---

## 合规与免责

- 本项目是个人自用的小工具，**与 X、腾讯均无关联**；
- 请自行确认使用方式符合 [X 服务条款](https://x.com/tos) 与 [QQ 机器人规范](https://q.qq.com/wiki/)；
- 抓取内容仅建议用于个人备份、小范围交流，不要用于商业分发；
- 使用小号、低频轮询、随机抖动都能降低风控概率，但**无法保证不会被限制**，请自行承担风险。

---

## License

[MIT](LICENSE) © 2026 x2qq contributors

`assets/verified.png` 仅作蓝 V 徽章占位，如涉及商标问题请替换或删除。
