# 预览会话排队计划

日期：2026-10-13。原编号：JEV-06。状态：已实施、本机部署和只读交接验收通过。
设计：[预览会话排队设计](./preview-session-queue-specs.md)。
上级计划：[共享服务优化计划](../shared-service/jev-reach-optimization-plan.md)。

2026-10-13 用户明确“确认实现”，授权执行本计划。占用语义、默认期限与验收标准以设计文档为唯一来源；此文件记录执行和结果。

## JEV-06.1 / 共享后端准入

状态：已实施。构建、纯调度检查和隔离浏览器交接验证通过。

实施入口：`src/scheduler.ts`、`src/server.ts`、`src/http.ts`，以及必要的窄工具说明。复用 `OperationQueue` 和 HTTP session 生命周期；添加整轮占用、FIFO 申请、取消/释放、代次检查与有界等待。只在当前关联契约确有需要时适配 bridge；不为调度另建服务或修改全局连接配置。

验证入口：新增 `test/session-queue.test.mjs` 的纯调度用例；在既有 `test/shared-http.test.mjs` 添加名为 `preview session ...` 的双客户端准入用例，并复用其 SDK/本地浏览器夹具。覆盖设计验收 1、3、4、5；现有嵌套队列用例用于直接回归。

预定命令，在 `/Users/mac/mygithubrepos/jev-reach` 执行：

```bash
rtk npm run build
rtk node --test test/session-queue.test.mjs
rtk node --test --test-name-pattern 'preview session|one queue admits nested' test/shared-http.test.mjs
```

构建包含已有补丁校验和本包编译，为运行编译产物所必需。改动 TS/JS 需检查实际变更段的 JSDoc 和源代码契约；新接口/跨文件类型由现有构建验证。先运行一个纯调度用例确认测试入口，再补齐必要分支。预计纯调度验证为秒级；已有真实浏览器单例设置 45 秒期限，新增用例采用同等有界预算。构建耗时尚未实测，预计分钟以内；不扩展依赖安装或完整测试套件。

结果与证据：新增 src/preview.ts 维护整轮占用、FIFO 预约、取消、活动保护、闲置回收和 QA 清理确认；src/scheduler.ts 统一守卫浏览器工具，src/server.ts 提供三个 debug_session 工具，src/http.ts 接入连接回收。等待不持有单次操作队列，未执行的输入不后台重放。后端记录本连接的 QA 注入入口，断连时调用现有、带 owner 校验的清理工具，清理完成前不交接。

rtk npm run build 通过；rtk node --test test/session-queue.test.mjs 的 6 个用例通过（84 毫秒）。限定真实浏览器验证覆盖跨调用独占、FIFO、QA 同组关联、异常断连后 Runtime 与刷新入口清理、凭证恢复确认、旧凭证拒绝；修正后单项命令 rtk node --test --test-name-pattern 'preview session browser' test/shared-http.test.mjs test/session-queue.test.mjs 通过（3.43 秒）。此前同文件的双真实客户端兼容用例通过（与新用例合计 2 项，7.4 秒）；嵌套队列、过期服务清理已通过。浏览器夹具使用独立 headless profile 和本地网站，不接触游戏预览，也不调用 TypeSafe。

## JEV-06.2 / QA 与普通调试共用占用

状态：已实施。Python 语法、文档和限定 7 项验证通过。

实施入口：`tools/cocos-jev-qa/src/cocos_jev_qa/web_runner.py`、`mcp_server.py`，以及必要的 Web Runtime 所有者守卫 `owners.py`。为 QA 内部 Chrome 连接申请/关联占用，覆盖 Web 页面发现、prepare、用例/手动 Runtime 操作、detach 和 client close。复用现有客户端所有权及 QA 全局文件锁，不改变 Android 路径或游戏适配器。

测试入口：既有 `tools/cocos-jev-qa/tests/test_web_runner.py`、`test_mcp.py` 的客户端和 Chrome doubles；增加独立 `PreviewQueueTests` 分组，测试凭证关联、等待不产生输入、prepare 失败释放、detach/close、手动 Runtime 守卫和活动用例保护。复用现有清理失败测试，保持原错误和回执语义。

预定命令，在 `/Users/mac/mygithubrepos/codex/tools/cocos-jev-qa` 执行；`QA_PYTHON` 在实施前从现有 QA 启动器解析到当前锁定 Python，不另建 venv：

```bash
env PYTHONPATH=src "$QA_PYTHON" -B -m unittest tests.test_web_runner.PreviewQueueTests tests.test_mcp.PreviewQueueTests tests.test_web_runner.WebRunnerTests.test_close_reports_changed_origin_without_removing_the_foreign_page_entry
```

Python 模块/函数文档和新增参数的工具 schema 必须同步；新增分组覆盖设计验收 2、3、4、5。预期使用 mocks 的执行为秒级，实际成本待运行记录；若现有锁定环境不可用，停止相关准备并报告，不进行新的大范围环境安装。

结果与证据：WebRunner 在页面发现、prepare、用例、截图、手动 Runtime 查询前申请或关联占用；OwnedBridge.query 守卫已有 Web Runtime 操作。Host 在撤销后清理旧运行时，凭原本地能力确认断连清理。复用另一会话已实现的 QA 全局文件锁，未修改其 SessionStore 锁机制，也未新增第二套 QA 锁；Android 路径绕过 Web 占用守卫。

按上述锁定 Python 执行两个 PreviewQueueTests 分组、changed-origin 清理回归及 tests.test_mcp.McpTests.test_web_binding_discovery_and_roundtrip：7 项通过（最后一次 0.169 秒）。改动文件 AST 语法和函数 docstring 检查通过。限定验证覆盖等待不转发 Runtime 操作、凭证/活动关联、prepare 失败释放、异常断连恢复和已有 MCP 流程；不调用远端 TypeSafe。

## JEV-06.3 / 工具说明与现有调试规则

状态：已实施。源目录、语言、链接和两个 Skill 最小校验通过。

同步共享服务使用文档的申请、占用、等待和释放接口。仅更新 codex 仓库 `plugins/slothg-plugin/skills/cocos-project-rules/references/logging-debug-rules.md` 的 Chrome 预览调试章节，以及 `plugins/slothg-plugin/skills/cocos-jev-qa/SKILL.md` 中受影响的 Web 操作顺序。普通静态分析可在等待时继续；取得资格前禁止旁路预览操作；finally 清理并释放。

实施时通过 system `skill-creator` 与 owned `codex-skill-rules` 维护入口确认来源和语言策略。只改源仓库相关段落，运行对应最小技能校验；当前加载模式为 source，不修改安装缓存、全局 AGENTS 或无关技能。规则复核不得替代 JEV-06.1/2 的后端强制控制。

结果与证据：增加 cocos-jev-qa/references/preview-session-queue.md；在既有 SKILL.md 和 logging-debug-rules.md 的 Web 预览入口引用，说明申请、关联、等待、finally 清理和无旁路要求。共享服务使用文档同步三个 debug_session 工具与默认期限。两个受影响 Skill 的 quick_validate.py 均通过；当前加载目录解析至源仓库，未编辑缓存或全局配置，保留并行会话的通用调试/截图改动。

## JEV-06.4 / 本机交付与现有预览只读验收

状态：已部署。运行版本、补丁、产物一致性和现有预览只读交接均通过。

依赖 JEV-06.1/2 的必要验证通过；使用已有 tgz 安装流程更新 `/Users/mac/.agents/mcp/jev-reach`，QA 沿用现有维护入口。记录版本、补丁校验与源码/运行产物一致性；不修改现有 Chrome 命令、参数或无关配置。

只有确认当前预览测试空闲后，才进行必要的后端/QA 有序重连。若仍有测试占用，停在已验证运行包阶段，记录待交付而不主动结束其他聊天。部署等待成本取决于现有测试，当前未知。

生效验证：读取运行服务版本；通过当前规则解析并明确选择一个已有 Cocos Web 预览，不启动 Creator。A 取得占用并执行只读观察；B 申请时等待且不接触页面；A 清理释放后 B 取得资格并执行只读观察，最后两方清理。对同一逻辑聊天的普通 Chrome 与 QA 关联再完成一次只读验证。点击/刷新/导航的竞争仅在 JEV-06.1 的隔离夹具测试。

报告实施、静态检查、夹具运行和现有预览结果四层证据。若预览不可访问或活动测试尚未结束，明确缺失条件，不将部署或预览验收标记完成。Git 提交/推送不在本计划范围。

结果与证据：运行版本 0.1.1-slothg.8。使用已有 npm pack --ignore-scripts 流程生成运行包，离线安装仅更新 1 个包；依赖仍为 chrome-devtools-mcp 1.9.0，11 个补丁文件校验通过。preview/scheduler/server/http/bridge 五项编译产物与安装目录逐字节一致。切换前确认 Chrome pending 为 0、QA 无被持有文件锁及 Runtime WebSocket，随后有序退出空闲旧后端和 QA 主机；未批量终止聊天，也未修改全局启动配置。

实际通过现有配置的 bridge 启动 .8 后端，并连接实际 QA HTTP 主机。明确选择已有 CocosCreator | noodleRestaurant 页面 http://localhost:7456/，只读观察得到 Cocos 2.4.15 / main-scene。A 占用时 B 返回 QUEUED、executed=false；QA 经本地凭证加入 A 并取得既有全局 QA 锁。A 释放后仍为 RELEASING，QA 正式 detach 完成后 B 才取得占用并读取同一页面；最后 IDLE、pending=0，QA 文件锁已释放。没有点击、刷新、导航、注入 Runtime 或启动 Creator。

首次验收的 Node SDK 持续 GET 连接触发已有 qa_client_close 的 SESSION_BUSY 保护；保留失败证据后，将夹具清理改为正式 qa_web_detach，再关闭传输及发送 DELETE，验收通过。该保护未改动，未把第一次失败称为通过。

本机备份：/Users/mac/.agents/mcp/jev-reach/backups/20261013-184302-JEV-06。运行包及接受证据位于 skill_cache/JEV-06/：jev-reach-0.1.1-slothg.8.tgz、live-acceptance.json、live-acceptance-first-failure.json、validation.json。包 SHA256 为 6aa579e8c551ab0ff9489607d07377e86e89cd83138d354dab4e527172b614d6。旧聊天连接需重新初始化 MCP 才能连接新服务并看到新增工具；已验证维护客户端通过原 bridge 正常初始化。没有 Git 提交或推送。

## 停止条件

用户确认前只允许本轮定位和设计/计划文档。确认后，遇到首次测试入口/夹具初始化失败先停止依赖用例，修复该入口；补丁摘要漂移、占用身份无法关联、取消后可能重放输入或旧操作未清理即交接时，停止交付并解决对应边界。必要限定检查通过后结束，不追加完整 `npm test`、项目范围的 Python 测试、真机或游戏功能审计。
