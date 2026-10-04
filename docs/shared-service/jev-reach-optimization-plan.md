# jev-reach 共享服务优化计划

日期：2026-10-04。Fork：https://github.com/slothg/jev-reach。
上游：https://github.com/rashedInt32/jev-reach；基线 `a301a87a5aa391e682e2e91465708f44062fe6fc`。
本地：`/Volumes/data/mygithubrepos/jev-reach`；开发分支 `codex/shared-backend`。

`main` 只保留上游内容；开发分支承载局部兼容补丁和共享服务。保留上游 MIT 许可及依赖的 Apache-2.0 许可。上游更新先合并至镜像分支，再合并到开发分支；依赖内容发生漂移时停止补丁应用并重新适配，不能强行覆盖。源码仍使用上游 TypeScript/Node 技术栈。

## 实施与验证

| 原编号 | 实施边界 | 静态验证 | 运行验证 |
| --- | --- | --- | --- |
| JEV-04、F-01、F-02 | 已实施：固定 chrome-devtools-mcp 1.9.0；版本化、摘要校验、备份和回滚的 Console 与 QA 补丁 | 通过：构建、九文件摘要；实际回滚、重新应用和校验 | 通过：既有 Console 6/6、启动 2/2；QA exports 已列出，未运行真实游戏 QA |
| JEV-01 | 已实施：本机 Streamable HTTP；每会话独立 SDK server/context；进程内共享 browser 与按需采集器；所有工具统一排队 | 通过：构建 | 通过：双客户端选中页、快照、文件根目录隔离；同页单组采集器；reach 与原工具排队 |
| JEV-02 | 已实施：页面发现不创建采集器或 DevTools universe；显式选择或页面工具调用时接管；release_page 释放接管 | 通过：构建与确切入口复核 | 通过：列出页面零采集；最后接管者释放后无采集器；evaluate_script 可重新接管 |
| JEV-03 | 已实施：焦点模拟随接管启停；会话切换恢复自身 emulation 设置 | 通过：构建 | 通过：双会话 User-Agent 切换；真实 Puppeteer 调用记录每页焦点覆盖启用一次、最后释放时关闭一次。未验收普通 Chrome 前台操作 |
| JEV-05 | 已实施：HTTP DELETE 关闭本会话；服务端口独占先于浏览器初始化；会话过期、服务空闲退出与信号关闭 | 通过：构建 | 通过：一客户端退出后另一客户端继续；重复端口失败；活动请求不过期；过期会话回收；CLI 空闲退出；CDP 不响应且最后客户端退出后仍按空闲期限进入有界清理并结束进程。SIGINT/SIGTERM 清理仅源码复核 |

## 预先限定的命令和停止条件

仓库内运行 `rtk npm run build`，随后运行 `rtk node --test test/server.test.mjs`。部署复核发现上游参数解析器内部调用 `hideBin()`，Fork 曾错误传入不带 Node/script 前缀的参数，导致前两个选项丢失；入口和 HTTP 测试 fixture 恢复完整 argv，并增加首个分类开关实际影响工具列表的回归用例。重跑启动、桥接和共享 HTTP 三个受影响的文件；Console 载荷未变，不重复该验证。

迁入 Console 补丁后运行：

```sh
CHROME_MCP_PACKAGE_ROOT=/Volumes/data/mygithubrepos/jev-reach/node_modules/chrome-devtools-mcp rtk node --test /Volumes/data/mygithubrepos/my-codex/tools/cocos-jev-qa/tests/chrome-console-memory.test.mjs
```

共享服务只运行 `rtk node --test test/shared-http.test.mjs`，使用本机已安装 Chrome 的独立无头、临时 profile 和本地 fixture；不连接用户普通 Chrome，不调用真实 TypeSafe，不启动 Cocos Creator。

补丁维护验证增加 `rtk node scripts/apply-devtools-patches.mjs --rollback`、重新构建及 `--check`，确认依赖可恢复、重新应用和校验。第一次双会话运行因测试缺少上游必需的 `pageId` 停止；修正测试参数后重新运行。释放顺序复核发现异步句柄释放可能晚于回收检查，改为同步登记 lease 释放再等待句柄清理，由最后接管者回收场景覆盖。

User-Agent 隔离失败后定位到 `evaluate_script` 自行解析页面、不走通用页面工具入口；为该入口补齐接管和模拟设置切换，并在同一用例增加释放后通过脚本重新接管、真实 CDP 焦点覆盖启停记录。

双会话场景通过后，针对尚未覆盖的 JEV-05 边界，在同一文件补充长请求跨越会话空闲阈值仍存活、CLI 服务空闲后实际退出；同时检查 HTTP Origin 拒绝和会话数量上限。最终仅重跑该文件和改过入口对应的启动测试。

每个独立场景有超时；出现持续增长、卡顿、未预期页面访问或无法清理进程即停止相应场景。以上范围通过后停止，不运行 `npm test` 全套，也不做 10 GB 压力复现。

全局 Codex MCP 配置和已运行连接器的切换另行交付具体配置与回滚说明。本计划的代码验证不等于真实游戏内存验收。

## 本轮结果与证据

2026-10-04：Fork 关系已通过 GitHub 页面和仓库 API 确认，parent 为 `rashedInt32/jev-reach`。`origin/main`、本地 `main` 和 `upstream/main` 位于上述基线；优化集中在 `codex/shared-backend`，保留上游同步路径。没有发布 npm 包或推送开发分支。

| 验证 | 结果 | 证据位置 |
| --- | --- | --- |
| 构建与补丁应用 | 退出 0；TypeScript 编译成功，九文件应用通过 | `.test-artifacts/build-validation.log` |
| 启动限定测试 | 3 项通过，0 失败，约 3.95 秒；包含首个 CLI 选项回归 | `.test-artifacts/server-validation.log` |
| 共享 HTTP 原有用例 | 4 项通过；新增用例首次因 fixture URL 缺少 `/mcp` 失败，修正后只重跑该新增用例 | `.test-artifacts/shared-http-validation.log`；截图 `.test-artifacts/shared-http-uhHpQ5/a/a.png` |
| 无响应 CDP 的退出边界 | 1 项通过，0 失败，约 7.29 秒；客户端退出后进程以 0 退出，日志确认 idle 清理 | `.test-artifacts/stalled-cdp-validation.log`；`rtk node --test --test-name-pattern 'last disconnected client' test/shared-http.test.mjs` |
| 正常 MCP 桥接启动 | 1 项通过，0 失败，约 3.91 秒；并发启动只创建一个后端，roots 转发、心跳、客户端退出与后端空闲回收通过 | `.test-artifacts/bridge-validation.log`；`.test-artifacts/bridge-Fr2FbY/` |
| Console 限定测试 | 6 项通过，0 失败，约 0.86 秒；载荷摘要保持 `7094b06470db6a03d8a8f027efd5e99722e4de1a357f9346616b5ed69ff75ee1` | 现有 `my-codex/tools/cocos-jev-qa/tests/chrome-console-memory.test.mjs` 的执行结果 |
| 九文件实际回滚、重应用、检查 | 顺序返回 `RESTORED`、`PATCHED`、`VERIFIED`，均退出 0 | `scripts/apply-devtools-patches.mjs` 和 manifest；`.jev-reach-originals/` 原始备份 |

测试只启动本机隔离无头 Chrome，TypeSafe 请求均发往本地 mock。Node 26.5.0 的 localStorage 环境警告不影响通过结果。完整测试套件与 Cocos 压力测试没有运行。

代码复核按 `code-simplifier` 限定于本任务修改：移除未使用的测试 helper 和临时诊断，保留资源生命周期、队列与错误清理；发现并修正的独立实现问题是释放登记顺序和脚本工具绕过页面入口，均由上述用例覆盖。

限定用例合计 **15 项均已通过**；新增退出用例修正 fixture URL 后按名称单独重跑，未重复其他已通过用例。本地运行包与配置切换见下一节；已运行的连接器仍需重连，不能把源码测试当作当前会话已经切换。

## JEV-01 / JEV-05 部署与配置切换

用户已授权安装、切换 MCP 配置并提交 Fork 与配置仓库，并指出 LaunchAgent 不符合预期启动方式。已停止并移走本任务创建的 LaunchAgent，切换前配置仍保持不变。改为 Codex 启动 `dist/bridge.js`：每客户端一个轻量 STDIO 入口，后端不存在时启动共享 HTTP 服务；不加载 Chrome 模块。后端固定端口 4071，保留默认无会话空闲 5 分钟退出；入口 EOF 时 DELETE 自身 session。入口存活时发送 MCP ping，进程硬退出后停止心跳并由 HTTP 会话超时回收。保留原先 `--autoConnect`、视觉工具和 workspace。

限定验证：构建和 `test/bridge.test.mjs`，验证并发入口共享、roots 双向转发、单客户端退出、心跳与最后客户端退出后的后端回收；健康元数据改变后只重跑 `test/shared-http.test.mjs`。随后 `npm pack --ignore-scripts`、运行目录 `npm install --omit=dev --no-audit --no-fund`、安装器 `--check`；两个 STDIO 客户端通过部署入口初始化、工具列表及分别退出。普通 Chrome 仅尝试 `list_pages`，不接管或修改页面；若浏览器外部连接受阻则停止重复该尝试，单独记录待验收，MCP 初始化和工具列表作为配置入口切换的验证门槛。修改配置前保存完整原文件，修改后解析 TOML 并确认只改变 chrome-devtools 配置块；完整同步 `config.toml` 和 `AGENTS.md` 至配置仓库并验证字节一致。若 MCP 启动、初始化或工具列表失败，停止相关切换步骤，保留原配置；不运行全套测试。

配置提交只包括本任务文档和完整 Codex 备份；Fork 提交仅包含前述优化文件、按需入口与部署说明。没有用户推送指令，不推送远端。

部署验证中两个 STDIO 客户端并发初始化成功，列出 35 个工具。真实普通 Chrome 的 `list_pages` 在 20 秒后超时；本地日志确认阻塞位于 `Connecting Puppeteer`，9222 TCP 连接已建立但未完成浏览器协议初始化。Chrome 的远程调试授权状态仍待用户确认，原因未最终确认；不能把 MCP 初始化和工具列表通过报告为浏览器验收通过。

该现场还暴露 JEV-05 的独立退出问题：会话已删但未完成 CDP 请求仍占用队列，原空闲判断要求 `queue.pending===0`，可无限拖延后端退出。现改为按无会话时间触发 CLI shutdown，复用五秒清理期限；无活动会话时仅结束本后端。新增本地 WebSocket 黑洞用例真实完成握手但不响应 CDP，工具请求超时后退出客户端，确认后端仍按 idle 路径以 0 退出。普通 Chrome 连接超时原因不由该修复解决。

最终已安装 `0.1.1-slothg.4`，tgz SHA-256 为 `eb70d0aa083c863f6f462c493c3ee8b9abd2d5b731aa85641bf0f2c3341d3ff7`；九文件 `--check` 返回 VERIFIED。安装后的 `bridge.js`、`http.js`、`service-config.js`、`index.js` 与源码编译产物字节一致。两个最终部署入口并发初始化、列出 35 个工具、一客户端退出后另一客户端继续、最后退出后 `sessions=0/pending=0` 均通过；没有重复尝试受阻的普通 Chrome 连接。证据为 `.test-artifacts/deployment-mcp.json`。

`~/.codex/config.toml` 仅替换 `mcp_servers.chrome-devtools.args[0]` 为 `~/.agents/mcp/jev-reach/node_modules/jev-reach/dist/bridge.js`，其余字段、参数、环境变量与切换前一致。完整备份位于 `my-codex/backups/codex/`，两个文件均字节一致：config SHA-256 `5ee4224c343cf5b7b37c77285427601f44fc646eee9a8165d5a5123b3ed027fd`；AGENTS SHA-256 `15181c8c20c617d4919f650d0f5223295d7fac25959f9d60e1386bc21a5d17ce`。切换前完整文件保留在 `~/.agents/mcp/jev-reach/backups/2026-10-04-before-http/`，名称沿用准备阶段命名，不表示最终使用 URL 配置。没有已加载的本任务 LaunchAgent，活动 plist 不存在。

本机 `codex-cli 0.142.3` 直接读取完整配置时，因切换前已存在的 `features.context_management` 表报 `invalid type: map, expected a boolean`。该字段不是本次修改，保持原样；仅为只读检查执行 `codex -c 'features.context_management=false' mcp get chrome-devtools --json`，成功解析为 STDIO 和新入口，此临时覆盖不修改配置文件。静态 TOML 等值比较与实际 SDK 初始化也通过。已运行 Codex 连接器尚未在本任务中重启或重连，普通 Chrome 前台、真实 TypeSafe 与 Cocos 内存趋势仍待验收。
