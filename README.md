# LingGuangBot-QQ（凌光姬-QQ）

> 把 X（Twitter）账号的新推文自动转发到 QQ 群或 QQ 私聊，成品是一张近似 QQ 原生的推文卡片。

<p align="left">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="node" src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg">
  <img alt="dependencies" src="https://img.shields.io/badge/dependencies-0-success.svg">
  <a href="https://github.com/maxlglky/LingGuangBot-QQ/actions/workflows/test.yml"><img alt="tests" src="https://github.com/maxlglky/LingGuangBot-QQ/actions/workflows/test.yml/badge.svg"></a>
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg">
</p>

想第一时间看到某个账号的更新，又不想一直刷 X？把它交给 LingGuangBot-QQ：
默认每 5 分钟检查一次，有新推就发到你的群或私聊。

**卡片里会还原这些细节**（都按 X 客户端的样式来）：

| 元素 | 效果 |
| --- | --- |
| 头像 + 蓝 V | `# ![头像] **账号名** ![认证]` |
| 转推横幅 | `## **⇄ 谁 已转帖**` + `> 转帖于 …` |
| 回复标记 | `**↩ 回复 谁**`，下面跟着被回复的原推（缩进引用块） |
| 引用推文 | `## 原推作者` + 正文 + 配图，整块 `>` 缩进 |
| 配图 | 真实宽高、多图并排；也可以改成卡片外的图片消息（见 `imageMode`） |
| @提及 / #标签 | 正文里的 `@某人`、`#标签` 都变成可点击链接，点开分别跳 `https://x.com/某人` 和 `https://x.com/hashtag/标签`（主推 / 转帖 / 引用 / 回复都一样） |
| 图片人物标记 | 图下 `> X账号1 及另外4人` |
| 外链卡片 | fanicon / TikTok 这类链接预览：发预览图 + `> 来自 fanicon.net` |
| 视频 | 卡片里提示 `> 🎬 视频共 N 段`，视频单独一条消息发（QQ 的 Markdown 放不下视频） |
| 翻译 | 正文、引用、被回复原推都翻，页脚标 `由X自动翻译` |

**工程上的几个特点**：

- **零依赖**：只用 Node.js 内置模块，clone 下来直接跑，不需要 `npm install`
- **零第三方服务**：用自己账号的 cookie 直连 X，不需要 RSS 服务、不需要付费 API
- **会听指令**：`/订阅`、`/退订`、`/最新`、`/转推 <推文id>`、`/翻译 开`、`/回复 <账号> 关` 都在聊天里完成
- **群聊、私聊同一套逻辑**

---

## 目录

- [效果](#效果)
- [部署](#部署)
  - [前置条件](#前置条件)
  - [五步跑起来](#五步跑起来)
  - [拿 X cookie](#拿-x-cookie)
  - [常驻与开机自启](#常驻与开机自启)
  - [用 AI Agent 部署](#用-ai-agent-部署)
  - [上线检查清单](#上线检查清单)
- [配置说明](#配置说明)
- [群聊与私聊](#群聊与私聊)
- [命令行工具](#命令行工具)
- [开发](#开发)
  - [目录结构](#目录结构)
  - [一次推送的完整流程](#一次推送的完整流程)
  - [想改某个地方](#想改某个地方)
  - [测试与调试技巧](#测试与调试技巧)
- [设计取舍](#设计取舍)
- [已知限制](#已知限制)
- [FAQ / 排错](#faq--排错)
- [合规与免责](#合规与免责)
- [License](#license)

---

## 效果

一条「转推 + 引用 + 配图 + 翻译」的卡片长这样（图片链接已省略）：

```
## **⇄ X账号A 已转帖**
> 转帖于 2026-10-28 20:06

# ![头像] **X账号A** ![认证]

这是示例推文的正文内容。

这里可能是多行文本，例如时间、地点等。详情见 [@X账号2](https://x.com/example_account2)，相关话题 [#示例标签](https://x.com/hashtag/示例标签)。

![推文配图 #600px #450px](…)
> X账号1 及另外4人

> ## X账号B
>
> 这是被引用 / 被转帖的推文的正文。
>
> ![引用配图 #520px #390px](…)
> 来自 fanicon.net
>
> 2026-10-27 21:46｜[查看原帖 ↗](…)

由X自动翻译
2026-10-28 20:06｜[查看原帖 ↗](…)
```

层级约定：

- 主推账号名用 `#`（最大字号 + 加粗），转推横幅和引用作者用 `##`；
- 被引用 / 被回复的内容整块用 `>` 缩进，块内的配图、人物标记、卡片来源也跟着缩进；
- 正文里的 `@某人` / `#标签` 是 Markdown 链接，点开分别跳个人主页和标签页，和 X 上一样；
- 页脚时间是**推文本身的发布时间**，和 X 页面上显示的一致；转推不改变它。

---

## 部署

有两条路：照下面的步骤手动来，或者把[提示词](#用-ai-agent-部署)丢给 AI Agent 让它代劳。

### 前置条件

| 需要 | 说明 |
| --- | --- |
| Node.js **22+** | <https://nodejs.org/>，装 LTS 版即可 |
| QQ 机器人 | 在 [q.qq.com](https://q.qq.com/) 创建，拿到 `AppID` / `AppSecret` |
| 能访问 X 的网络 | 国内需自备代理（下文以 `127.0.0.1:17899` 为例） |
| X 账号 cookie | 建议用小号，获取方式见[下文](#拿-x-cookie) |
| 「单聊」能力（可选） | 想在私聊里用，需要机器人后台开通该能力 |

> 群里使用前，群主还要在手机 QQ 里给机器人打开「**主动推送消息**」权限，
> 否则发送会报 `40034105 主动消息失败, 无权限`。

### 五步跑起来

```bash
# 1. 拿到代码
git clone https://github.com/maxlglky/LingGuangBot-QQ.git
cd LingGuangBot-QQ

# 2. 生成配置
cp config.example.json config.json      # Windows: copy config.example.json config.json

# 3. 填三处内容（用编辑器打开 config.json）
#    qq.appId / qq.appSecret  ->  QQ 机器人后台的凭据
#    net.xCookie              ->  你的 X cookie（见下节）
#    net.proxy                ->  代理地址，直连可留空

# 4. 自检
node src/main.js doctor        # 凭据 / 推文源 / 会话名单
node src/main.js xprobe        # 打印每个账号最新的 3 条推文

# 5. 常驻
node src/main.js run           # Windows 也可以直接双击 start.cmd
```

自检正常时输出大致如下：

```
[1/3] 检查 QQ 凭据 ... OK
[2/3] 检查推文源 ... OK，拿到 2 条候选推文
[3/3] 检查群名单 ... OK，1 个群
基础检查通过。
```

然后把机器人拉进群，**@ 机器人** 发 `/订阅 <账号key>`。它会先推一条该账号的最新推文，
既是确认订阅成功，也顺便让你看看卡片效果。

### 拿 X cookie

1. 浏览器登录 <https://x.com>（建议小号）
2. `F12` → **Application** → **Cookies** → `https://x.com`
3. 复制 **`auth_token`**，顺手把 **`ct0`** 也复制上（更稳）
4. 拼成一行填进配置：

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
[xaccount1] 拉到 20 条，最新 3 条：
  2026-10-28T13:37:00.000Z  https://x.com/…
```

> cookie 会过期（几周到几个月不等）。过期后日志会出现 `X 拒绝了请求（401）`，
> 重新复制一次即可，其他配置不用动。

### 常驻与开机自启

| 方式 | 说明 |
| --- | --- |
| `node src/main.js run` | 前台运行，占着终端，`Ctrl+C` 停止 |
| `start.cmd`（Windows） | 带窗口运行，关窗即停；node 崩溃后 5 秒自动重启 |
| `stop.cmd`（Windows） | 按 PID 停止，并写入 `.stop` 标记，避免被自动重启拉起 |
| `autostart.vbs` | 静默启动，放进「启动」文件夹即可登录自启 |

如果要用本地代理拉 X：

```bat
rem 1. 用你的 Clash 订阅生成一份只监听本机 17899 的配置
node scripts\prepare-local-proxy.mjs C:\path\to\profile.yml 17899

rem 2. 告诉 start.cmd 用哪个 clash 可执行文件（不设就用 ClashForWindows 的默认路径）
set CLASH_EXE=C:\path\to\clash-win64.exe
```

`start.cmd` 的处理顺序：没有 `.proxy/config.yaml` 就先跑上面的脚本生成；
17899 没在监听就用 `CLASH_EXE` 把这份配置拉起来（窗口隐藏）。脚本只改端口和局域网开关，
不动订阅内容；也支持 `CLASH_PROFILE` / `PROXY_PORT` / `PROXY_CONTROLLER_PORT` 环境变量。

### 用 AI Agent 部署

不想自己敲命令？把下面**整段**复制给有终端权限的 AI Agent（Claude Code / Codex / Cursor 等），
它会自己 clone、向你索取凭据、自检并启动：

```text
请帮我部署 LingGuangBot-QQ —— 一个用 Node.js 写的「X 推文转发到 QQ 群/私聊」的自托管服务。

仓库：https://github.com/maxlglky/LingGuangBot-QQ
运行要求：Node.js 22+（项目零第三方依赖，不需要 npm install）

请按顺序执行，每步完成后简要汇报，遇到报错先诊断原因再继续：

1. 把仓库 clone 到本地一个合适目录并进入。
2. 阅读 README 的「部署」和「配置说明」两节，确认你理解了配置项含义。
3. 复制 config.example.json 为 config.json。
4. 向我索取以下信息，并只写入本地 config.json：
   - QQ 机器人 AppID、AppSecret
   - X 的 auth_token（以及可选的 ct0），用于拉取推文
   - 本机代理地址（如果访问 X 需要代理；直连就留空）
   注意：不要把这些值打印到对话里，也不要写进任何会被 git 提交的文件。
5. 依次运行 `node src/main.js doctor` 和 `node src/main.js xprobe` 做自检。
   如果报错，对照 README 的「FAQ / 排错」处理，常见的是：
   - `401` → cookie 过期或无效
   - `40034105` → 群没有开启「主动推送消息」权限
6. 自检通过后启动常驻：
   - Windows：运行 start.cmd
   - Linux / macOS：`node src/main.js run`（需要后台常驻就用 systemd / pm2）
7. 最后告诉我：
   - 怎么在 QQ 群里让它开始工作（@机器人 发 `/订阅 <账号key>`）
   - 怎么查看运行状态（`node src/main.js status`）
   - 日志在哪里（`logs/run-YYYY-MM-DD.log`）

约束：
- 不要提交 config.json、state*.json、logs/、.proxy/
- 不要修改 src/ 下的业务代码，除非是为了修复明显的环境兼容问题，改动前先说明。
```

> Agent 拿到凭据后，建议你自己再核对一遍 `config.json`；跑通后记得把它从任何备份或同步目录里排除。

### 上线检查清单

- [ ] `node src/main.js doctor` 三项全绿（凭据 / 推文源 / 群名单）
- [ ] `node src/main.js xprobe` 能拿到最新推文
- [ ] 群里 `/订阅` 有回复，并且收到了一条最新推文
- [ ] 群主已开启「主动推送消息」
- [ ] 私聊发 `/订阅` 也有回复（需要机器人后台开通「单聊」能力）
- [ ] 日志 `logs/run-日期.log` 里每 5 分钟有一条「本轮结束」记录
- [ ] 重启一次服务，历史推文不会被重复推送（`state.json` 记着已读）

---

## 配置说明

`config.json` 的结构参考 `config.example.json`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |
| `stateFile` | `state.json` | 运行状态：会话、已读、开关、健康数据 |
| `qq.appId` / `qq.appSecret` | — | QQ 机器人凭据 |
| `qq.apiBase` | `https://api.bot.qq.com` | OpenAPI 地址 |
| `qq.tokenBase` | `https://bots.qq.com` | 换取 access_token 的地址 |
| `net.proxy` | — | 拉取 X 和下载媒体的代理；直连留空 |
| `net.xCookie` | — | `auth_token=…; ct0=…` |
| `x.maxAgeHours` | `24` | 只处理这么多小时内的推文 |
| `x.includeReplies` | 按账号配置 | 账号级「回复」总闸（示例中为 `true`） |
| `x.includeRetweets` | 按账号配置 | 账号级「转推」总闸（示例中为 `true`） |
| `forward.intervalSec` | `300` | 基础轮询间隔 |
| `forward.intervalJitterSec` | `60` | 每轮额外随机增加 `0~N` 秒，降低风控概率 |
| `forward.accountStaggerSec` | `3` | 同一轮内账号之间随机错开 |
| `forward.maxPerRun` | `5` | 每轮最多推送几条 |
| `forward.maxPushAgeHours` | `6` | 超过这个小时数的推文不再补发（`0` 表示关闭） |
| `forward.maxImages` | `6` | 单条最多发几张图 |
| `forward.sendImages` | `true` | 关掉就只发文字卡片，完全不碰媒体 |
| `forward.originalImage` | `false` | 图片用 X 上的**原图**（`?name=orig`）而不是默认压缩版。实测同一张图：默认 `900×1200 / 234KB`，原图 `1536×2048 / 548KB`。代价是流量和发送耗时变高 |
| `forward.maxVideoMB` | `30` | 视频接受的最大体积（MB）。按「码率 × 时长」估算，挑装得下的最高画质。QQ 的软限是 30MB（超了会被降级成「文件」、不能直接播放），硬限 200MB |
| `forward.quote` | `true` | 引用推文是否一起渲染（关掉只保留主推） |
| `forward.verifiedBadge` | `true` | 是否显示蓝 V 徽章 |
| `forward.imageMode` | `auto` | 图片放哪：`inline` 内嵌进卡片 / `message` 单独发图片消息 / `media` 图文同条（文字+首图一个气泡，纯文本） / `auto` 素材库宽裕时内嵌、快满了自动改成单独发（推荐） |
| `forward.mediaInlineUntil` | `92` | `auto` 模式的切换线：素材库少于这个张数才内嵌 |
| `forward.headerCacheHours` | `12` | 头像 / 徽章素材的缓存时长，过期后重新上传（防止素材被淘汰后链接失效） |
| `forward.avatarCacheHours` | `168` | 头像/徽章的素材复用时长（头像基本不变，缓存久一点省配额） |
| `forward.mediaCacheHours` | `6` | 内嵌图片素材缓存的有效期。超过就重新上传，避免复用已被回收的链接（群里表现是图片一直「加载中」）。`0` = 每次重传 |
| `forward.mediaPruneAt` | `90` | 素材库用量达到多少张时触发回收 |
| `forward.mediaKeep` | `60` | 回收时删到多少张为止（从最旧的开始删） |
| `forward.maxMarkdownChars` | `4000` | 单条 Markdown 上限 |
| `forward.style` | `markdown` | `markdown` / `text` / `media` / `ark` |
| `forward.markdownImage` | — | 老配置项，等价于 `imageMode: "inline"`；新配置直接用 `imageMode`，不需要它 |
| `forward.perMinute` / `perDay` | `15` / `200` | 每个会话的发送频率限制 |
| `forward.timeZone` | `Asia/Shanghai` | 卡片时间使用的时区 |
| `accounts[]` | — | 账号列表，见下 |

单个账号的配置：

```jsonc
{
  "key": "xaccount1",                    // 群里用 /订阅 xaccount1
  "handle": "example_account",
  "displayName": "X账号1",               // 卡片上显示的账号名
  "provider": "xcookie",                // 目前有 xcookie / file(调试用)
  "userId": "0000000000000000000",      // 数字 ID，留空会自动查询
  "includeReplies": true,
  "includeRetweets": true,
  "maxAgeHours": 24
}
```

#### 再加一个账号

1. 在 `accounts` 数组里追加一项，`key` 取个好记的短名字（群里用它订阅），
   `handle` 填 X 的 `@` 后面的名字，`userId` 可以先留空；
2. 重启服务（配置只在启动时读一次）；
3. 在群里 @ 机器人发 `/订阅 <key>`，它会先推一条该账号的最新推文。

> `userId` 留空时第一次拉取会自动查询并写回 `state.xgraphql.json`，不影响使用；
> 想指定头像就用 `avatarUrl`，不填则用 X 上的头像。

---

## 群聊与私聊

群聊和私聊共用同一套指令和订阅逻辑，区别只有两点：要不要 @，以及权限限制。

- **群聊**：@ 机器人发指令；群主需要开启「主动推送消息」权限
- **私聊**：直接给机器人发消息，不用 @；没有「主动推送消息」这个概念

指令（群里 @ 机器人，私聊直接发）：

| 指令 | 作用 |
| --- | --- |
| `/订阅` | 查看本会话订阅状态 |
| `/订阅 <账号>` | 订阅，并立刻推一条该账号的最新推文 |
| `/退订 <账号>` | 取消订阅 |
| `/最新 [账号]` | 发一条最新推文：不带参数取本会话已订阅账号里最新的一条；带账号（如 `/最新 xaccount1`）则取该账号最新，**不需要先订阅** |
| `/转推 <推文id>` | 立刻把指定推文发出来（不看订阅、不看新旧）。id 就是链接里 `status/` 后面那串数字，也可以直接贴整条链接 |
| `/翻译 开` / `/翻译 关` | 是否使用 X 自带的中文翻译（正文和引用一起翻） |
| `/回复 <账号> 开\|关` | 是否转发该账号的「回复」 |
| `/转贴 <账号> 开\|关` | 是否转发该账号的「转贴」 |

补充说明：

- 机器人被拉进群时**只登记、不推送**，必须发 `/订阅` 才会开始；
- 订阅时「回复」「转贴」默认开启，之后可以单独关掉；
- 所有开关都**按会话**保存，A 群关了不影响 B 群；
- `/转推` 不受订阅影响：没订阅的账号、超出补发时限的旧推文，都能手动转出来；
- 私聊消息不用 @ 也会响应，细节见下一节。

### 私聊（C2C）

**开启方式**

1. 在 QQ 里打开机器人资料卡（群聊里点头像，或从机器人列表进入），点「发消息」；
2. 如果发消息后毫无反应，先到 [QQ 机器人后台](https://q.qq.com/) 确认已开通「**单聊**」能力（部分主体需要申请）；
3. 直接发 `/订阅 <账号key>`，用法和群里一致。

**和群聊的差异**

| 项目 | 群聊 | 私聊 |
| --- | --- | --- |
| 触发方式 | 需要 @ 机器人 | 直接发消息 |
| 主动推送权限 | 群主在手机 QQ 里开启 | 无此概念，不需要设置 |
| 会话标识 | `group_openid` | `c2c:<user_openid>` |
| 发送接口 | `/v2/groups/{id}/messages` | `/v2/users/{id}/messages` |
| 回复措辞 | 「发到本群」 | 「发到这里」 |

**注意事项**

- 私聊会话会出现在 `node src/main.js groups` 的列表里，前缀是 `c2c:`；
- 私聊的订阅关系、翻译开关、回复 / 转贴开关都**独立保存**，不与群共享；
- 私聊推送同样受 `forward.perMinute` / `forward.perDay` 限制；
- 私聊完全没回应时，先看日志里有没有 `C2C_MESSAGE_CREATE`：
  没有说明平台没把事件推过来（通常是没有「单聊」能力）；有事件但发送失败，则是权限或密钥问题。

---

## 命令行工具

```bash
node src/main.js doctor            # 体检：凭据 / 推文源 / 会话名单
node src/main.js run               # 常驻：监听事件 + 轮询 + 推送
node src/main.js once              # 跑一轮
node src/main.js once --dry-run    # 跑一轮但只打印，不发送
node src/main.js once --seed       # 把现有推文全部标记为已读
node src/main.js status            # 健康状态：轮次 / 最后成功 / 连续失败
node src/main.js media             # 素材库状态：张数 / 缓存是否过期 / 回收阈值
node src/main.js media --clean     # 图片又发不出去时，把素材库回收到 mediaKeep 以下
node src/main.js xprobe            # 验证 X cookie，打印最新推文
node src/main.js groups            # 查看已登记会话与订阅关系
node src/main.js groups enable <openid>    # 打开某个会话的推送
node src/main.js groups disable <openid>   # 关掉某个会话的推送
node src/main.js groups remove <openid>    # 从名单里删掉
node src/main.js watch             # 只监听事件，自动登记机器人所在的群

# 手动试发（调样式、排查群权限）
node src/main.js send-test --account <key> --id <推文id> --group <openid>
node src/main.js send-tweet <推文链接> [--group <openid>]
```

---

## 开发

### 目录结构

```
src/
├─ main.js      CLI 入口 + 指令处理（订阅 / 退订 / 最新 / 转推 / 翻译 / 回复 / 转贴）
├─ poller.js    轮询调度：拉取 → 过滤 → 去重 → 逐会话投递；翻译、人物标记、外链卡片都在这里汇总
├─ xgraphql.js  X 客户端：cookie、queryId 自动刷新、UserTweets / UserReplies / TweetResultByRestId、翻译
├─ tweet.js     推文对象规范化、去重键、行首 @ 剥离
├─ qq.js        QQ OpenAPI：token / 发送 / 素材上传 / 分片上传 / 媒体 / 素材回收
├─ gateway.js   WebSocket 网关：群事件 + 私聊事件
├─ format.js    Markdown 卡片渲染（转推 / 回复 / 引用 / 人物标记 / 卡片来源 / 视频提示 / 翻译标记）
├─ fx.js        FxTwitter 详情：引用、真实图片尺寸、视频多档
├─ store.js     state.json：会话、已读、开关、健康状态
├─ http.js      请求封装（代理、超时、大小上限、瞬断自动重试）
├─ commands.js  指令关键词匹配、推文 id 解析
└─ util.js      日志（控制台 + 按天文件）、时间格式化、原子写

test/pipeline.test.js   单测（mock QQ 服务 + 本地推文源）
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

几个关键点：

1. **每个账号每轮只拉一次**，结果在内存里复用给所有会话，避免重复请求 X；
2. **能不能推**要过三层闸门：账号级（`includeReplies/Retweets`）→ 会话级（`itemFlags`）
   → 时间窗（`maxAgeHours` / `maxPushAgeHours`）；
3. **失败不阻塞**：某个会话发送失败只记一条 `部分失败`，不影响其他会话；翻译失败则回落原文。

### 想改某个地方

| 想改 | 去哪 |
| --- | --- |
| 卡片样式（字号、间距、字段顺序） | `src/format.js` 的 `formatTweetMarkdown` |
| 新增一个指令 | `src/main.js` 的 `onMessage`（先 `normalizeCommand`，再分支） |
| 换数据源 | 新增 `src/xxx.js` 导出 `fetchXxx`，在 `src/poller.js` 的 `fetchRaw` 里加 `case`，输出同样的 item 结构即可 |
| 调整过滤 / 去重 | `src/poller.js` 的 `tickAccount` |
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
node test/pipeline.test.js          # 25 个用例：渲染、过滤、去重、限频、素材回收、卡片元素、端到端
node src/main.js once --dry-run     # 真跑一轮但只打印，改样式时最常用
node src/main.js xprobe             # 只验证 X 侧
```

- 单测使用 `provider: "file"` + 本地 JSON 推文源，不碰网络；
- 调样式时先 `--dry-run` 看 Markdown，再用 `send-test --group <小群>` 看实际渲染，别直接发大群；
- X 改版导致 `queryId` 失效时，程序会自动重新抓取并写入 `state.json.xgraphql.json`，
  日志会打印 `已刷新 X 的 GraphQL queryId`。

---

## 设计取舍

**为什么用 cookie 抓 X，而不是 RSS 或第三方 API？**

| 方案 | 延迟 | 成本 | 问题 |
| --- | --- | --- | --- |
| RSS（rss.app 等） | 不可控，实测出现过 **17 小时** | 免费 | 收录延迟、会回填旧推 |
| SocialData / twitterapi.io | 秒级 | 按条计费，实测约 **$3.6/天** | 免费额度很快耗尽（402） |
| 公共 RSSHub 实例 | — | — | Twitter 路由已全部关闭（404/503） |
| **X cookie + GraphQL（本方案）** | ≈ 轮询间隔 | 免费 | cookie 会过期，建议用小号 |

**为什么卡片里没有视频？** QQ 的 Markdown 不支持视频，所以视频单独作为消息发送，
卡片里只留一行提示。

**为什么正文行首要插零宽空格？** QQ 会把行首的 `#` 当标题、`>` 当引用，
插一个不可见字符就能阻断语法，不影响阅读。

**`@提及` / `#标签` 是怎么变成链接的？** QQ 的 Markdown 支持 `[文字](链接)`，所以渲染前会把正文里的
实体改写成链接：

| 原文 | 渲染成 | 点开 |
| --- | --- | --- |
| `@某人` | `[@某人](https://x.com/某人)` | 个人主页 |
| `#标签` | `[#标签](https://x.com/hashtag/标签)` | 标签页 |

规则和 X 一致：

- 提及只认 1–15 位的 `A-Za-z0-9_` 用户名，前后不能紧贴字母数字（`中@文`、`@a@b` 都不算）；
- 标签允许中文/假名/数字/下划线，碰到空白、标点、emoji 就结束（`#ハロウィン🎃` 只链 `#ハロウィン`）；
- 邮箱（`foo@bar.com`）、URL 里的内容、以及 `##标题` 这类 Markdown 语法原样保留；
- 主推、转帖内容、引用块、被回复原推都走同一套处理，译文里的实体也会被改写。

**为什么 `#标签` 不翻译？** X 自己的翻译接口不翻标签 —— 实测换过 16 种
`translationSource`、8 种语言码、Android/iOS 的 UA，`#夢のポップスター公演` 都原样返回
（标签在它眼里是 entity，不进翻译）。X 客户端里能翻，走的是另一套没开放的后端。
本项目坚持不接第三方翻译，所以标签保留原文；正文、引用、被回复原推都会翻。

**图片下面那行「某某 及另外 N 人」是哪来的？** X 的图片可以标记人物，
数据在 `extended_entities.media[].features.all.tags[]`（每个 tag 带 `name` / `screen_name` / `user_id`）。
fxtwitter 不返回这个字段，所以：

- 主推文 / 转帖内容：直接用 X GraphQL 时间线里的 `media[].features`（转推会看 `retweeted_status_result` 里的原推）；
- 引用推文 / 被回复的原推：fxtwitter 只有正文和图片，没有标记，所以额外查一次 GraphQL
  `TweetResultByRestId`（按 id 取单条），结果按 tweet id 缓存，一条推文只查一次。

渲染时按 X 的样式压成一行引用块放在图片下面：一个人就直接写名字，多个就写「第一个 及另外 N 人」。
引用块里的图片也走同一套逻辑，标记会出现在引用块内部。没有标记的推文不会多出这一行。

**带外链卡片的推文（比如 fanicon 的「New Post Available」）怎么处理？**
这类推文的媒体其实是 X 的链接预览卡片，fxtwitter 只返回 `twitter_card: "tweet"` 一个枚举值，
内容在 GraphQL 的 `card.legacy.binding_values` 里（`domain` / `title` / `photo_image_full_size_original` 等）。
所以没有自带图片时，会把卡片预览图当成图片发出去（同样走素材库或图片消息），
并在图片下面补一行 `> 来自 fanicon.net`，和 X 客户端的显示一致。

三种位置都支持：

- **转帖 / 主推文**：直接走主推文那套（自带图片优先，没有才用卡片图）；
- **引用推文 / 被回复的原推**：额外查一次 GraphQL 拿卡片，卡片图会出现在引用块内部，
  `来自 xxx` 也在块内（同样缩进）。

卡片是**视频**的情况分两种：

| 卡片类型 | 处理 |
| --- | --- |
| `summary_large_image`（TikTok、fanicon 这类） | X 只给了封面图，没有视频地址 —— 发封面图 + `> 来自 tiktok.com` |
| `player`（带 `player_stream_url`，如 YouTube） | 有可下载的视频流，就把视频当普通视频发（`> 🎬 视频共 1 段`），`来自 xxx` 跟在卡片里，封面图只作为兜底 |

> 判断依据是卡片里有没有 `player_stream_url`；没有就只能发封面，
> 因为 X 本身没有把站点视频转存过来。

视频卡片在三种位置都生效：转帖 / 主推文的视频作为普通视频消息发；
引用推文 / 被回复原推的视频会在卡片之后补一条视频消息，引用块里则写 `🎬 视频见下条消息`。

**为什么图片要传素材？** 官方文档说 Markdown 里的图片可以直接用公网 URL
（平台会下载转存），但**腾讯的服务器连不到 `pbs.twimg.com`** —— 实测：
同一张 Markdown 里放腾讯 COS 的公共图能正常显示，放 X 图床的图（带不带参数都一样）
就加载不出来。所以才要先把图传到「素材管理」，拿 `qqbot-media://` 引用。

**图片画质是怎么定的？** X 的图床支持 `?name=` 参数控制尺寸，默认返回的是压缩版
（实测同一张图：默认 `900×1200 / 234KB`，`?name=orig` 是 `1536×2048 / 548KB`）。
fxtwitter 给的链接本身就带 `name=orig`，但走 GraphQL 兜底时拿到的是不带参数的压缩版。
打开 `forward.originalImage` 后会统一改写成 `?name=orig`；原图超过平台 10MB 限制时，
自动退到 `4096x4096` → `large` → `medium` 再试。
上传到素材库的内容我们验证过是**字节一致的原图**（没有被平台二次压缩）。

素材库的关键限制（都来自[官方文档](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html)）：

| 项目 | 限制 |
| --- | --- |
| 数量 | 单机器人 **100 张**，超了 `prepare` 直接 40035007 |
| 单张大小 | ≤ 10MB，格式 png / jpeg / gif / webp |
| 有效期 | **滑动过期**：每次被消息引用后顺延，连续 90 天没人引用才失效 |
| 查询 | 一页 20 条，翻页用 **`cursor`**（`offset/limit/page` 都没用） |
| 删除 | 删了只影响**新消息**能否再引用；**已发送的消息不受影响**（发送时平台已转存副本）✅ 已实测 |

所以回收策略很直接：到 `mediaPruneAt`（默认 90 张）就用 `cursor` 翻全库，
**从最旧的开始删**，删到 `mediaKeep`（默认 60 张）为止 —— 最近发的图一张都不动，
已发出去的图也不会因此消失。

至于卡片里放不放图，`imageMode` 三种：

| 值 | 效果 |
| --- | --- |
| `auto`（默认） | 素材库 < `mediaInlineUntil` 时内嵌；快满了自动降级成单独发（兜底，几乎不会触发） |
| `inline` | 永远内嵌 |
| `message` | 永远单独发图片消息（不占配额） |
| `media` | 图文同条：文字 + 首图一条消息，其余图接着发。不占配额，但**正文只能是纯文本** |

> 想一次腾空素材库：`node src/main.js media --clean`。

---

## 已知限制

这些是平台本身的约束，不是 bug，写在这里免得反复排查：

| 限制 | 说明 |
| --- | --- |
| 素材库 **100 张** | QQ 的硬上限，超了连头像都传不上去（`40035007`）。本程序会自动回收最旧的，但**历史消息里的图会随回收失效** |
| `#标签` 不翻译 | X 的翻译接口不翻标签，又不接第三方，所以保留原文（见[设计取舍](#设计取舍)） |
| 被动回复最多 5 条 | `/最新`、`/转推` 走被动回复，卡片占 1 条，所以最多再跟 4 张图 / 视频；超出的内容不会发 |
| 视频软限 30MB / 硬限 200MB | 超过 30MB 平台会把视频**降级成「文件」**（不能直接播放），超过 200MB 直接报错。程序按码率 × 时长估算挑档，`maxVideoMB` 可调 |
| 卡片里不能放视频 | QQ 的 Markdown 不支持视频，视频永远是单独一条消息 |
| `pbs.twimg.com` 客户端连不上 | 必须经素材库转存；直连公网图片 URL 在 QQ 客户端里加载不出来 |
| cookie 会过期 | 几周到几个月不等，日志报 `401` 时重新复制一次 |

---

## FAQ / 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `X 拒绝了请求（401）` | cookie 过期，重新复制 `auth_token` |
| `40034105 主动消息失败, 无权限` | 群主没开「主动推送消息」 |
| `账号 xxx 本轮拉取失败` + `ECONNRESET` / `TLS` | 代理抖动。程序对 GET 会自动重试 2 次；只失败一轮会在下轮自己补上，连续失败才需要查网络 |
| 图片发不出来 | 检查代理是否可用；失败时会只发文字卡片 |
| 图片一直「加载中」/「加载失败」 | 该图片引用的素材已不在库里。程序发消息前会核对缓存、发现死链就重传；用 `node src/main.js media` 看库容 |
| 图片和头像突然全没了（日志有 `40035007`） | 素材库满 100 张。程序会自动回收旧素材再重传；想一次腾干净用 `node src/main.js media --clean` |
| 老消息里的图突然不见了 | 素材被回收了，平台限制，无法恢复 |
| 视频没发或变糊 | 看日志里的 `视频选档：1280x720 @2176kbps ≈ 7.8MB（上限 30MB）`。想换更高画质就调大 `maxVideoMB`，但超过 30MB 会变成文件 |
| 卡片里没有引用块 | 引用推文获取失败（X 限流或推文已删），日志会有 `准备引用推文失败` |
| 重复推送 | 转推的转帖 id 与原推 id 已双向标记；若仍出现，检查 `state.json` 是否被并发写 |
| `/订阅` 没反应 | 看日志有没有 `收到指令`；没有则是网关事件没进来（intents / 机器人能力） |
| 私聊发指令没反应 | 机器人后台没开「单聊」能力；看日志有没有 `C2C_MESSAGE_CREATE` |
| 服务好像停了 | `node src/main.js status` 看「上次轮询」是否在 10 分钟内 |
| 日志找不到 | `logs/run-YYYY-MM-DD.log`，按天分文件，跨天也会自动切换 |

---

## 合规与免责

> **实现声明**：这个项目是围绕个人使用场景摸索出来的实现，**不一定是最优方案**。
> 例如「用登录 cookie 抓 X」属于非官方手段，卡片样式也只能近似 QQ 原生卡片；
> 如果你的需求可以用官方 API 或 Webhook 满足，请优先选择官方方案。

- 本项目是个人自用的小工具，**与 X、腾讯均无关联**；
- 请自行确认使用方式符合 [X 服务条款](https://x.com/tos) 与 [QQ 机器人规范](https://q.qq.com/wiki/)；
- 抓取内容建议仅用于个人备份和小范围交流，不要用于商业分发；
- 使用小号、低频轮询、随机抖动都能降低风控概率，但**无法保证不会被限制**，请自行承担风险。

---

## License

[MIT](LICENSE) © 2026 Max凌光 (LingGuangBot-QQ)

`assets/verified.png` 仅作蓝 V 徽章占位，如涉及商标问题请替换或删除。
