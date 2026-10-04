# jev-reach

This fork adds a normal MCP STDIO bridge that starts and reuses one shared
loopback HTTP backend, lazy page collectors, and reversible compatibility
patches for chrome-devtools-mcp 1.9.0. The original STDIO entry remains available.
See the [shared service guide](docs/shared-service/jev-reach-shared-service-usage.md)
for startup, session ownership, limitations, rollback, and upstream updates.
The original project is [rashedInt32/jev-reach](https://github.com/rashedInt32/jev-reach).

[chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) plus one
tool. `reach` walks the browser to the spot where you want to look, using
[TypeSafe Jev](https://docs.typesafe.ai) to pick each click. Then you make one
devtools call there instead of one call per click.

Everything chrome-devtools-mcp does still works, unchanged, in the same process
and the same Chrome. jev-reach registers one extra tool on top.

## Why

Verifying a frontend bug usually starts with a walk: dismiss the cookie banner,
log in, open Settings, expand the third row. With a plain browser MCP each of
those is a full model turn, and each turn reads a page snapshot into context.
The reasoning only starts once you arrive.

`reach` moves the walk to Jev. Jev is a decision model: it picks one element and
one action from a typed list in about 300 ms and never reads or writes free text.
Your model states the goal once, gets back a status and a step trace, and then
calls `list_console_messages`, `list_network_requests`, `take_snapshot`, or
`take_screenshot` on the same tab. The walk is recorded for those calls, because
it happened on the same page objects the stock collectors listen to.

## Install

Requires Node 20.19+ or 22.12+, Chrome, and a TypeSafe API key from
[console.typesafe.ai](https://console.typesafe.ai/settings/keys).

### Claude Code plugin

Two commands inside a session:

```text
/plugin marketplace add rashedInt32/jev-reach
/plugin install jev-reach@jev-reach
```

The plugin runs the published package through `npx -y jev-reach@<version> --isolated`.
It registers a server named `chrome-devtools` that includes every stock devtools
tool plus `reach`, so remove your existing chrome-devtools-mcp entry first.
Keeping both gives you two Chromes and two copies of every tool:

```bash
claude mcp remove chrome-devtools
```

The key must reach the server. Put it in `~/.config/typesafe/key` with mode 0600,
or export `TYPESAFE_API_KEY` in the shell that starts Claude Code.

### Any MCP client

Replace your chrome-devtools-mcp entry with jev-reach and keep the flags:

```bash
claude mcp remove chrome-devtools
claude mcp add chrome-devtools -e TYPESAFE_API_KEY=your-key -- npx -y jev-reach --isolated
```

Any MCP client:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "jev-reach", "--isolated"],
      "env": { "TYPESAFE_API_KEY": "your-key" }
    }
  }
}
```

Every chrome-devtools-mcp flag is accepted and none is required. `--isolated` is
only the example because it gives each agent session its own throwaway Chrome.
The other stock modes work the same way, verified with the same walk:

| mode | flags | what reach walks |
|---|---|---|
| isolated | `--isolated` | a fresh Chrome per session, temp profile |
| persistent | no flag | the stock profile in `~/.cache/chrome-devtools-mcp`, logins kept |
| attach | `--browserUrl http://127.0.0.1:9222` or `--autoConnect` | your own running Chrome |

The stock rule applies: one server per persistent profile at a time. Running a
second session against the same profile fails with the stock "browser is
already running" error, which is what `--isolated` is for.

The key can also live in `~/.config/typesafe/key` with mode 0600.

## Use

```text
reach({
  goal: "Sign in with the supplied email and password so the Settings page is showing.",
  url: "http://127.0.0.1:3000/login.html",
  values: { email: "dev@example.test", password: "..." }
})
```

returns (a real run against the test fixture, headless Chrome launch included):

```json
{
  "status": "done",
  "page_id": 1,
  "url": "http://127.0.0.1:3000/settings.html",
  "title": "Settings",
  "steps": [
    { "step": 1, "action": "type", "target": "input[email] \"Email\"", "confidence": 0.96, "goal": 0.02, "latency_ms": 1032 },
    { "step": 2, "action": "type", "target": "input[password] \"Password\"", "confidence": 0.95, "goal": 0.02, "latency_ms": 432 },
    { "step": 3, "action": "click", "target": "button \"Sign in\"", "confidence": 0.73, "goal": 0.03, "latency_ms": 421 },
    { "step": 4, "action": "finish", "goal": 0.92, "latency_ms": 2030, "note": "done" }
  ],
  "usage": { "calls": 4, "input_tokens": 3831, "output_tokens": 859, "jev_ms": 3915, "total_ms": 6573 }
}
```

Then:

```text
list_console_messages({ pageId: 1 })
```

The page id matters. chrome-devtools-mcp routes page-scoped tools by id, and the
id is invisible outside the process, so `reach` hands it back.

Console and network history follow the stock rules: buffered per navigation,
newest first. Messages from pages the walk passed through are in the earlier
navigation buckets, and the current page's messages are what the default call
shows.

### Inputs

| name | meaning |
|---|---|
| `goal` | The state to reach, in one sentence. Say what should be visible at the end. |
| `url` | Navigate here first. Omit to start from the current page. |
| `tab_url_prefix` | Act on the open tab whose URL starts with this instead of the selected tab. |
| `values` | Named strings Jev may type. Only the names reach Jev; the values go to the browser. |
| `max_steps` | Step budget, default 15. |
| `allow_irreversible` | Let Jev click through order, pay, send, delete, publish. Default false. |
| `settle_ms` | Network-quiet time after each action, default 500. |
| `timeout_ms` | Wall-clock budget, default 60000. |

### Statuses

| status | meaning |
|---|---|
| `done` | Jev rates the goal reached at 0.85 or above. |
| `likely_done` | The page looks done but Jev is unsure. Verify before moving on. |
| `needs_confirmation` | The next action looks irreversible. See `pending`. Re-run with `allow_irreversible` only if the user wants it. |
| `needs_login` | A sign-in wall and no `values`. Pass credentials. |
| `stuck` | Nothing changed for three actions. See `candidates` for the top elements. |
| `blocked` | Captcha, access denied, or an error page. |
| `max_steps`, `timeout` | Budget spent. |

No page text is ever returned. The follow-up devtools call is where you read the
page.

## How it works

```
reach(goal)
  │ warm the stock server: internal list_pages launches Chrome and attaches
  │ the console and network collectors, and names the selected tab
  ├─ loop
  │    1. snapshot: visible, enabled interactive elements in the main frame and
  │       open shadow roots, numbered, in-viewport first
  │    2. one parallel Jev call: element, action, value binding, goal reached,
  │       irreversible, login wall, blocked
  │    3. act through puppeteer on the same page objects
  │    4. settle on network quiet, diff url + text + inputs
  └─ status, page_id, url, title, steps, usage
```

Above 254 candidates the list is split, each chunk shortlisted in parallel, and
the winners plus the in-viewport elements go to the main call.

Native `alert` dialogs are accepted and logged. `confirm` and `prompt` count as
irreversible: they are dismissed and the walk stops with `needs_confirmation`.

## Limits

- Navigation only. Jev never judges whether the bug is fixed.
- Jev never generates text. Anything typed comes from `values`.
- Irreversible detection is a model judgment plus a keyword list. It is a guard,
  not a security boundary.
- Page text is sent to TypeSafe for each step. Fine for local dev pages; think
  about it for client sites.
- Main frame and open shadow roots. Iframes, file upload, and drag are not
  handled yet.
- `reach` has its own mutex and does not share the stock tool mutex. Do not run
  it in parallel with other browser tools.
- chrome-devtools-mcp is pinned to an exact version because jev-reach relies on
  its internals. Boot fails loudly if the pin is broken.

## Environment

| variable | meaning |
|---|---|
| `TYPESAFE_API_KEY` | The key. Or `~/.config/typesafe/key`, or `JEV_KEY_FILE`. |
| `JEV_MODEL` | Model id, default `jev-latest`. |
| `JEV_TIMEOUT_MS` | Per-request timeout, default 15000. |
| `JEV_REACH_LOG` | `1` prints one stderr line per step. |

## Development

```bash
npm install
npm run build
npm test                       # offline: helpers and server boot
JEV_REACH_E2E=1 npm run test:e2e   # launches headless Chrome; scripted Jev
JEV_REACH_E2E=1 TYPESAFE_API_KEY=... npm run test:e2e   # adds a live run
```

## Credits

The describe, decide, act loop with typed statuses is ported from the wave of
Jev browser projects, in particular
[Ying-Kai-Liao/jev-browser](https://github.com/Ying-Kai-Liao/jev-browser) and
[Browser Use's jev-ultrafast](https://github.com/browser-use/jev-ultrafast).
What is new here is running that loop inside chrome-devtools-mcp's own process,
so the devtools surface, the isolation model, and the recorded console and
network stay exactly as they are.

## License

MIT
