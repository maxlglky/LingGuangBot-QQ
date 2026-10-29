# 参与贡献

感谢你看这个项目。它是个人自用的小工具，但欢迎 issue 和 PR。

## 开发环境

- Node.js **22+**
- 无第三方依赖，**不需要 `npm install`**

```bash
git clone git@github.com:maxlglky/LingGuangBot-QQ.git
cd LingGuangBot-QQ
cp config.example.json config.json   # 填自己的凭据，这个文件不会被提交
```

## 跑测试

```bash
node test/pipeline.test.js           # 单元测试（mock QQ 服务 + 本地推文源）
node src/main.js once --dry-run      # 真跑一轮但只打印，调试渲染最常用
```

测试不依赖网络，也不会碰到真实的 QQ / X。

## 提交前请检查

1. `node test/pipeline.test.js` 全绿（CI 也会跑，但本地先过一遍更快）；
2. **不要提交 `config.json`**、`state*.json`、`logs/`、`.proxy/`（`.gitignore` 已覆盖，仍请 `git status` 确认一眼）；
3. 不要提交任何真实 cookie / AppSecret，包括测试夹具里；
4. 新增文件注意换行：文本用 LF，`.cmd` / `.bat` 用 CRLF（`.gitattributes` 已处理）。

## 提交信息

参考 [Conventional Commits](https://www.conventionalcommits.org/) 的简单版本：

```
feat: 新增 xxx 功能
fix: 修复 xxx 问题
docs: 只改文档
chore: 构建 / 依赖 / 杂项
refactor: 不改行为的重构
test: 只改测试
```

一句话说清改了什么即可，中文英文都行。

## 提 PR

1. 从 `main` 拉一个分支：`git checkout -b feat/xxx`
2. 改动尽量小、聚焦一件事，方便 review
3. PR 描述里写：**改了什么 / 为什么改 / 怎么验证的**（贴一段 `--dry-run` 输出最好）
4. 涉及卡片样式的改动，请附一张小群里的实际渲染截图

## 报 Bug

请带上这些信息，能省很多来回：

- 现象（截图更好）和相关日志：`logs/run-YYYY-MM-DD.log` 里对应的几行
- `node src/main.js status` 的输出
- `node src/main.js doctor` 的输出（**注意先抹掉 appId / cookie**）
- 运行环境：系统、Node 版本

## 关于 QQ / X 的限制

有些「问题」不是代码 bug，而是平台限制，提 issue 前可以先确认：

| 现象 | 是否为已知限制 |
| --- | --- |
| 群里收不到推文，报 `40034105` | 群主没开「主动推送消息」权限 |
| 图片只显示文字 | 图片 alt 必须同时带宽高，或代理不可用 |
| 视频没发出来 | 超过 100MB 会自动降档；看日志 `视频: …` |
| 某条推文没被转发 | 可能在 `maxAgeHours` / `maxPushAgeHours` 窗口外，或该会话关了「回复/转贴」 |

## 许可

提交的代码默认按本项目的 [MIT License](LICENSE) 授权。
