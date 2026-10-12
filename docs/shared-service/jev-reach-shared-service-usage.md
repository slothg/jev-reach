# jev-reach 共享服务使用与上游同步

本 Fork 通过本机 Streamable HTTP 共享一个浏览器后端。Codex 正常使用 `command/args` 启动 `dist/bridge.js`：每客户端入口仅转发协议，不创建工具 server 或导入 Chrome；后端不存在时才启动，多个会话复用一个后端进程和页面采集资源。代码位于 `/Volumes/data/mygithubrepos/jev-reach` 的 `codex/shared-backend`；依赖固定为 `chrome-devtools-mcp 1.9.0` 与 HTTP SDK `1.30.0`。

共享模式关闭 source maps 和 usage statistics，暂不支持 `--category-extensions`。需要这些功能时使用原 `dist/index.js` STDIO 模式。实际 `reach` 仍会向 TypeSafe 发送原有决策状态，使用前沿用原项目的凭据与授权范围；自动化测试只调用本地 mock。本方案不使用 LaunchAgent、登录项或系统服务；后端由 MCP 入口按需创建，并按会话生命周期回收。

从 `0.1.1-slothg.6` 起，维护的 Chrome MCP 依赖补丁在建立 DebuggerModel 前禁用异步调用栈收集。其他 inspector 连接请求的异步栈会同时出现在日常 DevTools，可能让其 Console DOM 大幅膨胀；只在日常 DevTools 勾选禁用不足以覆盖 MCP 的独立连接。此修正减少 MCP 的跨异步任务堆栈信息，不改变页面的 async/await、Promise 或定时器执行。更新安装后需重启已有后端，释放旧的调试连接。

从 `0.1.1-slothg.7` 起，每个扩展 Service Worker 日志采集器合计最多保留 30,000 条，跨扩展按时间顺序淘汰最旧消息；淘汰、clearLogs 和 dispose 会释放参数句柄及异常对象，dispose 同时清空缓存。同一 Puppeteer ConsoleMessage 被多个 MCP 会话保留时，等最后一个持有者释放，避免影响其他会话查看参数。普通页面 Console 仍为每次导航 10,000 条、最多 3 次导航，合计 30,000 条；数量上限不等于字节上限。

此版本也补齐 Service Worker 订阅失败或关闭时尚在初始化的连接清理、DevTools universe 初始化失败的 dispose/detach，以及第三方开发工具失败后的 DOM stash 和新句柄清理。第三方工具输入 UID 的句柄由原快照持有，失败清理不释放这些借用句柄。

## 使用正常 MCP 入口

安装运行包至 `~/.agents/mcp/jev-reach/` 后，在 Codex 配置中使用下面的入口。参数沿用原 Chrome 连接方式；不需要先手动启动 HTTP 服务。

```toml
[mcp_servers.chrome-devtools]
command = "/usr/local/bin/node"
args = [
  "/Users/rainbow/.agents/mcp/jev-reach/node_modules/jev-reach/dist/bridge.js",
  "--no-usage-statistics",
  "--no-performance-crux",
  "--autoConnect",
  "--experimentalVision",
  "--workspace=/Users/rainbow/.codex/browser-workspace"
]
```

入口检查 4071 健康状态和版本、配置摘要。需要启动时，先独占 4072 的短期启动锁，再检查一次后端；并发入口只由锁持有者创建后端，其他入口等待并复用。锁在启动完成或入口退出时由系统释放，不作为常驻服务。共享后端仍独占 4071；其他占用或配置不匹配会明确报错，不替换现有监听进程。自定义后端端口时，启动锁使用其下一端口；65535 使用 65534。

每个 STDIO 管道对应一个 HTTP session，并双向转发工具、roots 请求、结果和通知。选中页与快照等状态仍由后端按会话保存。入口存活时发送 MCP ping；正常 EOF/退出删除自身 session，最后会话退出后后端默认空闲五分钟关闭，不自动重启。即使此前客户端的 CDP 请求卡住，空闲退出仍触发，并最多等待五秒清理后结束后端进程。入口遭 SIGKILL 等硬退出时，HTTP session 在停止心跳后按三十分钟超时回收。仍会有每会话转发入口进程，但不会为每个会话创建 Chrome 连接、页面采集器或完整 MCP 后端。

后端日志位于 `~/.agents/mcp/jev-reach/logs/backend-4071.stderr.log` 和对应 stdout 文件；只保存在本机。变更后端启动参数或升级版本时，需要在无活动会话时退出旧后端并重连 MCP；入口不会混用不同版本或配置。

## 单独启动 HTTP 服务

以下命令在 Fork 根目录执行。依赖安装与构建自动应用兼容补丁，启动时再次校验摘要；不能使用 `--ignore-scripts` 后跳过构建直接启动。

```sh
cd /Volumes/data/mygithubrepos/jev-reach
npm ci
npm run build
node dist/index.js --shared-http --isolated --headless --no-usage-statistics --no-performance-crux
```

这会使用独立临时 Chrome profile，监听 `http://127.0.0.1:4071/mcp`。该命令用于调试或直接使用 HTTP 的客户端；Codex 日常使用前述按需入口。连接已有调试 Chrome 时，将 `--isolated --headless` 替换为原先的 `--autoConnect` 或明确的 `--browserUrl` 参数。所有客户端使用同一端口，重复启动因 `EADDRINUSE` 失败，且不会初始化第二个浏览器连接。更换端口会创建另一个独立服务，不构成跨端口的全局锁。

```sh
curl --fail http://127.0.0.1:4071/health
```

健康检查返回 `status`、`sessions`、`pending` 和版本/配置摘要 `identity`，不会接管页面。服务只绑定 IPv4 loopback，拒绝其他 Host 和跨站 Origin；未提供网络部署或多用户鉴权模式。

| 服务参数 | 默认值 | 行为 |
| --- | --- | --- |
| `--shared-http` | 未启用 | 启用本机 HTTP；省略则使用 STDIO |
| `--port` | 4071 | 独占服务端口；0 只用于随机端口测试 |
| `--session-idle-ms` | 1800000 | 30 分钟无活动后关闭会话；活动请求不计入过期；0 禁用 |
| `--service-idle-ms` | 300000 | 最后会话清理完成后空闲 5 分钟关闭后端和监听；0 禁用 |
| `--max-sessions` | 16 | 达到上限后拒绝初始化新会话 |

普通 Chrome 参数由上游解析。默认开启 `pageId` 路由：页面工具需要传入本会话 `list_pages` 返回的 `pageId`；不要跨会话复用 ID。`--no-page-id-routing` 可恢复按选中页调用的模式。

服务沿用 `TYPESAFE_API_KEY`、`JEV_API_KEY` 或 `JEV_KEY_FILE`；默认文件为 `~/.config/typesafe/key`。按需入口将首个启动入口的环境传给共享后端；直接 HTTP URL 客户端不会将环境变量传入已经运行的后端。后端使用一套全局凭据，不按会话切换账户。没有配置凭据时，普通 DevTools 工具仍可使用，`reach` 会明确返回缺少凭据。

## 直接使用 HTTP URL

直接 HTTP 客户端也可连接以下 URL，但这种配置不能自行启动后端，因此当前切换使用前述 `bridge.js`。Codex 两种传输用法见 [官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。

```toml
[mcp_servers.chrome-devtools]
url = "http://127.0.0.1:4071/mcp"
startup_timeout_sec = 30
```

实际切换前验证安装包、MCP 初始化和工具列表，并保存完整的 `~/.codex/config.toml`。需要重连的客户端按会话处理，不批量终止其他会话。按照当前仓库规则，同步完整 `config.toml` 与 `AGENTS.md` 至 `my-codex/backups/codex/` 并验证字节一致。

运行目录放到 `~/.agents/mcp/jev-reach/`；Git 源码仍保留在 `/Volumes/data/mygithubrepos/jev-reach`。发布到本机时先构建，`npm pack --ignore-scripts` 保存编译结果，再从 tgz 执行运行目录的 `npm install --omit=dev --no-audit --no-fund`，最后运行安装目录 `scripts/apply-devtools-patches.mjs --check`。具体本机切换结果见优化计划。

## 接管与释放页面

`list_pages` 只创建会话内页面描述，不初始化 Console/Network 采集器、DevTools universe 或焦点模拟。`select_page`、`new_page`、页面工具、`evaluate_script` 和 `reach` 在实际使用目标页时接管页面。

同一个 Puppeteer Page 在整个服务内只拥有一组采集器和 DevTools universe；不同会话分别持有 lease。会话的选中页、页面 ID、快照、UID 映射、文件 roots 与模拟设置保持独立。页面内容、Cookie、Storage 和采集历史属于共享的真实 Chrome 页面，并不隔离；同页其他会话仍能看见浏览器修改与历史。所有浏览器工具统一串行排队，长时间的 `reach` 会延后其他工具调用。

```json
{"name":"release_page","arguments":{"pageId":3}}
```

`release_page` 不关闭 Chrome 页签，只丢弃本会话的快照与接管。其他会话仍持有该页时继续采集；最后接管者释放时销毁采集器、释放 Console 参数句柄、detach DevTools session，并对本 Puppeteer 连接调用 `emulateFocusedPage(false)`。下一次使用可重新接管。切换选中页不自动释放此前接管的页，需要调用 `release_page`、关闭页签或结束会话。

HTTP `DELETE /mcp` 终止当前 MCP session；客户端仅关闭网络连接时，服务可能要等会话超时才能回收。因此需要 SDK 客户端调用 `terminateSession()`，或保留有限的会话超时。会话退出不会关闭其他会话使用的浏览器后端；服务空闲退出或收到退出信号才统一回收。Ctrl+C 停止服务；客户端随后必须重新初始化 HTTP session。

焦点恢复只撤销本连接设置的覆盖，不主动改变用户当前前台窗口。模拟设置恢复按工具调用切换；不保证其他外部 CDP 客户端同时修改同页时的隔离。source maps 与扩展工具入口因上游全局状态暂不启用；上游仍可能订阅已连接 Chrome 的现有扩展 Service Worker，其日志遵循上述保留与释放规则。

## 维护与回滚兼容补丁

`patches/chrome-devtools-mcp-1.9.0/manifest.json` 记录原始及修补摘要，`scripts/devtools-patch-transforms.mjs` 使用唯一源码锚点完成局部修改。Console 与 QA 载荷来自现有 `my-codex/tools/cocos-jev-qa/`，保留既有六项 Console 测试和 QA exports。

补丁处理十一个依赖文件：`McpPage.js`、`ToolHandler.js`、`tools/pages.js`、`tools/script.js`、`index.js`、`devtools/DevtoolsUtils.js`、`collectors/PageCollector.js`、`collectors/ServiceWorkerCollector.js`、`tools/input.js` 以及新增共享资源、QA helper。应用前校验整组文件，原文件备份至依赖包的 `.jev-reach-originals/`；已知摘要之外的内容会拒绝覆盖。

```sh
node scripts/apply-devtools-patches.mjs --check
node scripts/apply-devtools-patches.mjs --rollback
```

回滚恢复所有原文件，新增 helper 留在原处但没有导入者。回滚后本 Fork 的启动校验会拒绝运行；若只想关闭共享传输，直接省略 `--shared-http`，无需回滚依赖。重新应用：

```sh
npm run patch:devtools
```

出现 `Dependency drift`、`Backup drift` 或 `Patch anchor changed` 时停止应用，核对实际版本和源码；不要删除备份、绕过摘要或直接改依赖版本。上游依赖升级必须重新适配深层导入、页面生命周期和 QA exports，然后执行计划中的限定测试。

全局配置回滚优先只将 `chrome-devtools.args[0]` 改回 `/Users/rainbow/.agents/mcp/chrome-devtools-mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`，保留之后的其他设置；再完整同步两个仓库备份并重连旧 STDIO 服务。切换前完整文件保存在 `~/.agents/mcp/jev-reach/backups/2026-10-04-before-http/`，全量恢复前须核对其后的配置变更。依赖回滚只作用于本次 Fork 的 `node_modules`，不会改变独立 Chrome MCP 安装。

## 保留上游更新能力

`origin` 指向 [slothg/jev-reach](https://github.com/slothg/jev-reach)，`upstream` 指向 [rashedInt32/jev-reach](https://github.com/rashedInt32/jev-reach)。`main` 保留上游历史，优化仅在 `codex/shared-backend`；上游 MIT 许可和依赖 Apache-2.0 声明保留。GitHub Fork 关系不因新增开发分支而改变。

先保存当前已授权的本地工作，使工作区干净，再执行以下同步步骤：

```sh
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch codex/shared-backend
git merge main
```

不 rebase 已公开分支，不 force push，也不让 GitHub Sync fork 覆盖优化分支。如果 `main` 无法快进，先核对意外提交；如果开发分支冲突，按具体冲突处理并复核补丁摘要。验证后再按明确的提交、推送授权发布相关分支。GitHub 官方 [同步 Fork 文档](https://docs.github.com/en/pull-requests/how-tos/work-with-forks/syncing-a-fork) 可作为后续操作参考。

限定验证及结果见 [优化计划](jev-reach-optimization-plan.md)。构建与这些用例通过只证明实现和覆盖到的本地场景；未进行真实 Cocos 10 GB 压力复现，不能宣称现场峰值问题已经解决。
