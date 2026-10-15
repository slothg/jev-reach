/**
 * The `reach` tool: registration, the warm-up, and the walk loop.
 *
 * Rules that shape it:
 *
 *  1. Warm the stock server first. Chrome launches and the console and network
 *     collectors attach on the first stock tool call, so reach dispatches an
 *     internal `list_pages` before touching the page. Everything the walk does
 *     is then recorded for the follow-up devtools call.
 *  2. Act on the tab the stock server has selected, so the caller's next
 *     devtools call can omit the page id and land on the same tab.
 *  3. Never return page text. The follow-up devtools call is where the caller
 *     reads the page.
 *  4. Values go to the browser only. Jev sees their names.
 */

import type { McpServer as SdkMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Browser, Dialog, ElementHandle, Page } from "puppeteer-core";
import { zod as z } from "chrome-devtools-mcp/build/src/third_party/index.js";
import { ensureBrowserConnected, ensureBrowserLaunched } from "chrome-devtools-mcp/build/src/browser.js";
import { askStep, excerpt, getClient, newUsage, shortlist } from "./jev.js";
import type { StepState, Usage } from "./jev.js";
import { inspectImage, imageSize } from "@slothg/jev-vision";
import {
  bindingSatisfied,
  consumedKeys,
  DEFAULT_MAX_STEPS,
  DEFAULT_SETTLE_CAP_MS,
  DEFAULT_SETTLE_MS,
  DEFAULT_TEXT_CHARS,
  DEFAULT_TIMEOUT_MS,
  decideStep,
  fieldSignature,
  fingerprint,
  Mutex,
  parsePages,
  rankCandidates,
  statusOnBudget,
  STUCK_AFTER,
  topLabels,
  truncate,
} from "./lib.js";
import type { Candidate, Decision, FinalStatus, ListedPage } from "./lib.js";
import { collectSnapshot } from "./snapshot.js";
import type { RawSnapshot } from "./snapshot.js";

const LOG = process.env.JEV_REACH_LOG === "1";
const log = (line: string): void => {
  if (LOG) console.error(`[jev-reach] ${line}`);
};

// ── Types ───────────────────────────────────────────────────────────────────

interface StepRecord {
  step: number;
  action: string;
  target?: string;
  confidence?: number;
  goal: number;
  latency_ms: number;
  note?: string;
}

interface ReachResult {
  status: FinalStatus;
  /** The stock pageId for the tab that was walked. Pass it to the follow-up devtools call. */
  page_id: number | null;
  url: string;
  title: string;
  steps: StepRecord[];
  candidates?: string[];
  pending?: { action: string; target: string; reason: string };
  info?: string;
  usage: Usage & { total_ms: number };
}

interface ReachInput {
  goal: string;
  url?: string;
  tab_url_prefix?: string;
  values?: Record<string, string>;
  max_steps?: number;
  allow_irreversible?: boolean;
  settle_ms?: number;
  timeout_ms?: number;
  vision?: boolean;
}

// ── Registration ────────────────────────────────────────────────────────────

const mutex = new Mutex();

type ResolvePage = (prefix?: string) => Promise<{ page: Page; pageId: number }>;

export function registerReach(server: SdkMcpServer, serverArgs: Record<string, unknown>, resolvePage?: ResolvePage): void {
  server.registerTool(
    "reach",
    {
      title: "Walk the browser to a spot with Jev",
      description:
        "Get the browser to the exact place where you want to look, in one call. Give a goal such as 'dismiss the cookie banner, log in, and open the Billing tab'. " +
        "Jev (TypeSafe's decision model) picks one element and one action per step in about 300 ms, with no page text entering your context. " +
        "Then call list_console_messages, list_network_requests, take_snapshot, or take_screenshot on the same tab; the walk is recorded for them. " +
        "Jev never types free text: pass anything to type in 'values' (for example {email, password}), and only the names are shown to Jev. " +
        "Stops before orders, payments, sends, deletes, and publishes unless allow_irreversible is set. " +
        "Acts on the currently selected page and returns its page_id; pass that as pageId to the follow-up call.",
      inputSchema: {
        goal: z.string().min(1).describe("The state to reach, in one sentence. Say what should be visible at the end."),
        url: z.string().url().optional().describe("Navigate here first. Omit to start from the current page."),
        tab_url_prefix: z.string().optional().describe("Act on the open tab whose URL starts with this instead of the selected tab."),
        values: z.record(z.string()).optional().describe("Named strings Jev may type, such as {email: ..., password: ...}. Only the names reach Jev."),
        max_steps: z.number().int().min(1).max(60).optional().describe(`Step budget. Default ${DEFAULT_MAX_STEPS}.`),
        allow_irreversible: z.boolean().optional().describe("Let Jev click through order, pay, send, delete, publish. Default false."),
        settle_ms: z.number().int().min(0).max(10_000).optional().describe(`Network-quiet time to wait after each action. Default ${DEFAULT_SETTLE_MS}.`),
        timeout_ms: z.number().int().min(1_000).max(600_000).optional().describe(`Wall-clock budget for the whole walk. Default ${DEFAULT_TIMEOUT_MS}.`),
        vision: z.boolean().optional().describe("Opt in to uploading viewport screenshots to TypeSafe for element selection. Default false; cannot be combined with supplied values."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input, extra) => {
      const release = await mutex.acquire();
      try {
        const result = await runReach(server, serverArgs, input as ReachInput, extra.signal, resolvePage);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }], isError: true };
      } finally {
        release();
      }
    },
  );
  server.registerTool("inspect_visual", {
    description: "Inspect the selected page screenshot with experimental Jev vision or locate one target with Box. Explicit remote-image opt-in is required. Returns normalized/pixel edges as evidence; never clicks or types.",
    inputSchema: {
      question: z.string().min(1).max(2000).optional(),
      target: z.string().min(1).max(2000).optional(),
      allow_remote: z.boolean(),
      tab_url_prefix: z.string().optional(),
      min_presence: z.number().min(0.5).max(1).optional(),
      min_confidence: z.number().min(0).max(1).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input, extra) => {
    const release = await mutex.acquire();
    try {
      if (!input.allow_remote) throw new Error("Remote image authorization required");
      if (!input.question && !input.target) throw new Error("Supply question or target");
      const listed = await warmUp(server, extra.signal);
      const selected = resolvePage ? await resolvePage(input.tab_url_prefix)
        : await pickPage(await currentBrowser(serverArgs), parsePages(listed), input.tab_url_prefix);
      const data = await selected.page.screenshot({ type: "png", captureBeyondViewport: false });
      const result = await inspectImage({ data, question: input.question, target: input.target,
        minPresence: input.min_presence, minConfidence: input.min_confidence }, getClient(), extra.signal);
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...result, page_id: selected.pageId }) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "Visual inspection failed" }] };
    } finally { release(); }
  });
}

// ── Warm-up: the stock server owns Chrome and the collectors ───────────────

/**
 * Dispatch the stock `list_pages` through the SDK's registered handler.
 *
 * Private API of @modelcontextprotocol/sdk, held steady by the exact pin on
 * chrome-devtools-mcp. The call launches Chrome on first use and creates the
 * context that attaches console and network collectors to every page.
 */
async function warmUp(server: SdkMcpServer, signal: AbortSignal): Promise<string> {
  const registry = (server as unknown as { _registeredTools?: Record<string, { handler?: unknown }> })._registeredTools;
  const tool = registry?.list_pages;
  if (!tool || typeof tool.handler !== "function") {
    throw new Error("jev-reach could not find the stock list_pages tool to warm the browser. The pinned chrome-devtools-mcp internals have changed.");
  }
  const result = (await (tool.handler as (args: unknown, extra: unknown) => Promise<unknown>)({}, { signal })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const text = (result.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");
  if (result.isError) throw new Error(`The browser could not be started: ${truncate(text, 300)}`);
  return text;
}

async function currentBrowser(serverArgs: Record<string, unknown>): Promise<Browser> {
  const a = serverArgs;
  const chromeArgs = ((a.chromeArg as unknown[] | undefined) ?? []).map(String);
  if (a.proxyServer) chromeArgs.push(`--proxy-server=${String(a.proxyServer)}`);
  const shared = {
    devtools: a.experimentalDevtools ?? false,
    blocklist: a.blockedUrlPattern ? (a.blockedUrlPattern as unknown[]).map(String) : undefined,
    allowlist: a.allowedUrlPattern ? (a.allowedUrlPattern as unknown[]).map(String) : undefined,
  };
  // The singleton is already connected after warm-up, so these options are
  // only consulted if Chrome died in between; they mirror the stock ones.
  if (a.browserUrl || a.wsEndpoint || a.autoConnect) {
    return ensureBrowserConnected({
      browserURL: a.browserUrl,
      wsEndpoint: a.wsEndpoint,
      wsHeaders: a.wsHeaders,
      channel: a.autoConnect ? a.channel : undefined,
      userDataDir: a.userDataDir,
      ...shared,
    });
  }
  return ensureBrowserLaunched({
    headless: a.headless,
    executablePath: a.executablePath,
    channel: a.channel,
    isolated: a.isolated ?? false,
    userDataDir: a.userDataDir,
    viewport: a.viewport,
    chromeArgs,
    ignoreDefaultChromeArgs: ((a.ignoreDefaultChromeArg as unknown[] | undefined) ?? []).map(String),
    acceptInsecureCerts: a.acceptInsecureCerts,
    enableExtensions: a.categoryExtensions,
    viaCli: a.viaCli,
    ...shared,
  });
}

/**
 * Choose the puppeteer page to walk and the stock page id that names it.
 *
 * The id comes from the warm-up `list_pages` text, matched to puppeteer pages
 * by URL. Ids are per tab and survive navigation, so the id returned before
 * the walk still names the tab after it.
 */
async function pickPage(browser: Browser, listed: ListedPage[], prefix: string | undefined): Promise<{ page: Page; pageId: number | null }> {
  const pages = await browser.pages();
  if (pages.length === 0) throw new Error("The browser has no open page.");
  const idFor = (page: Page): number | null => listed.find((l) => l.url === page.url())?.id ?? null;
  if (prefix) {
    const hit = pages.find((p) => p.url().startsWith(prefix));
    if (!hit) throw new Error(`No open tab starts with ${prefix}. Open it first or drop tab_url_prefix.`);
    return { page: hit, pageId: idFor(hit) };
  }
  const selected = listed.find((l) => l.selected);
  if (selected) {
    const hit = pages.find((p) => p.url() === selected.url);
    if (hit) return { page: hit, pageId: selected.id };
  }
  const first = pages[0] as Page;
  return { page: first, pageId: idFor(first) };
}

// ── The walk ────────────────────────────────────────────────────────────────

async function runReach(server: SdkMcpServer, serverArgs: Record<string, unknown>, input: ReachInput, signal: AbortSignal, resolvePage?: ResolvePage): Promise<ReachResult> {
  const started = performance.now();
  const values = input.values ?? {};
  const valueKeys = Object.keys(values);
  if (input.vision && valueKeys.length) throw new Error("Vision cannot upload screenshots while supplied values may be displayed; use text mode with values");
  const maxSteps = input.max_steps ?? DEFAULT_MAX_STEPS;
  const settleMs = input.settle_ms ?? DEFAULT_SETTLE_MS;
  const timeoutMs = input.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const allowIrreversible = input.allow_irreversible ?? false;
  const usage = newUsage();
  const steps: StepRecord[] = [];
  const tsc = getClient();

  const pagesText = await warmUp(server, signal);
  const browser = await currentBrowser(serverArgs);
  const { page, pageId } = resolvePage
    ? await resolvePage(input.tab_url_prefix)
    : await pickPage(browser, parsePages(pagesText), input.tab_url_prefix);

  const finish = (status: FinalStatus, snap: Pick<RawSnapshot, "url" | "title">, extra: Partial<ReachResult> = {}): ReachResult => ({
    status,
    page_id: pageId,
    url: snap.url,
    title: snap.title,
    steps,
    ...extra,
    usage: { ...usage, total_ms: Math.round(performance.now() - started) },
  });

  // Dialogs: alerts are dismissed and logged; confirm and prompt are treated
  // as irreversible and end the walk unless the caller allowed that.
  let dialogSeen: { type: string; message: string } | null = null;
  const onDialog = (dialog: Dialog): void => {
    dialogSeen = { type: dialog.type(), message: dialog.message() };
    const accept = dialog.type() === "alert" || (allowIrreversible && dialog.type() !== "beforeunload");
    (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    log(`dialog ${dialog.type()}: ${truncate(dialog.message(), 80)} -> ${accept ? "accepted" : "dismissed"}`);
  };
  page.on("dialog", onDialog);

  try {
    if (input.url) {
      await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 30_000) });
      await settle(page, settleMs);
    }

    let lastAction = "none";
    let lastResult = "starting";
    let lastFingerprint: string | null = null;
    let noProgress = 0;
    let lastGoal: number | null = null;
    /** `${field signature}|${value key}` for every successful type action this run. */
    const typed = new Set<string>();
    let lastSnap: RawSnapshot = await snapshot(page);

    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) throw new Error("The client cancelled the request.");
      if (performance.now() - started > timeoutMs) return finish(statusOnBudget(lastGoal, "timeout"), lastSnap);

      const snap = lastSnap;
      const fp = fingerprint(snap);
      if (lastFingerprint !== null) {
        if (fp === lastFingerprint) {
          noProgress += 1;
          lastResult = "nothing on the page changed";
        } else {
          noProgress = 0;
        }
      }
      lastFingerprint = fp;
      if (noProgress >= STUCK_AFTER) {
        return finish("stuck", snap, { candidates: topLabels(snap.candidates), info: `No page change after ${STUCK_AFTER} consecutive actions. Last action: ${lastAction}.` });
      }

      const ranked = rankCandidates(snap.candidates);
      const state: StepState = {
        goal: input.goal,
        step,
        url: snap.url,
        title: snap.title,
        page_text: excerpt(snap.text, DEFAULT_TEXT_CHARS),
        last_action: lastAction,
        last_result: lastResult,
        available_values: valueKeys,
        element_count: snap.total,
      };
      const offered = await shortlist(tsc, state, ranked, usage, signal);
      if (input.vision) {
        const screenshot = await page.screenshot({ type: "png", captureBeyondViewport: false });
        imageSize(screenshot);
        state.screenshot = screenshot;
      }
      const consumed = consumedKeys(offered, valueKeys, values, typed);
      const { answers, latency_ms } = await askStep(tsc, state, offered, valueKeys, usage, signal, (c, key) => consumed.has(key) || bindingSatisfied(c, key, values, typed));
      lastGoal = answers.goal;
      const decision = decideStep(answers, { candidates: offered, hasValues: valueKeys.length > 0, allowIrreversible });
      log(`step ${step}: ${describeDecision(decision)} goal=${answers.goal.toFixed(2)} elem=${answers.element.choice}@${answers.element.confidence.toFixed(2)} action=${answers.action.choice}`);

      const record: StepRecord = { step, action: decision.kind === "act" || decision.kind === "confirm" ? decision.action : decision.kind, goal: answers.goal, latency_ms };
      if ((decision.kind === "act" || decision.kind === "confirm") && decision.target) {
        record.target = describeTarget(decision.target);
        record.confidence = answers.element.confidence;
      }

      if (decision.kind === "finish") {
        record.note = decision.status;
        steps.push(record);
        return finish(decision.status, snap);
      }
      if (decision.kind === "confirm") {
        record.note = "withheld";
        steps.push(record);
        return finish("needs_confirmation", snap, {
          pending: { action: decision.action, target: describeTarget(decision.target), reason: decision.reason },
          info: "Re-run with allow_irreversible: true only if the user wants this action taken.",
        });
      }
      if (decision.kind === "ambiguous" || decision.kind === "noop") {
        record.note = decision.reason;
        steps.push(record);
        lastAction = `${decision.kind}: ${decision.reason}`;
        noProgress += 1;
        if (noProgress >= STUCK_AFTER) {
          return finish("stuck", snap, { candidates: topLabels(ranked), info: decision.reason });
        }
        lastSnap = await snapshot(page);
        continue;
      }

      // act
      const outcome = await act(page, decision, values);
      steps.push(record);
      if (outcome.stale) {
        record.note = "page changed before the action; re-observed";
        lastAction = `${decision.action} (stale, skipped)`;
      } else {
        lastAction = decision.target ? `${decision.action} ${describeTarget(decision.target)}` : decision.action;
        if (decision.action === "type" && decision.target && decision.valueKey !== undefined) {
          typed.add(`${fieldSignature(decision.target)}|${decision.valueKey}`);
        }
      }
      await settle(page, settleMs);

      if (dialogSeen !== null) {
        const seen: { type: string; message: string } = dialogSeen;
        dialogSeen = null;
        record.note = `${seen.type} dialog: ${truncate(seen.message, 80)}`;
        if (seen.type !== "alert" && !allowIrreversible) {
          return finish("needs_confirmation", await snapshot(page), {
            pending: { action: "accept dialog", target: `${seen.type}: ${truncate(seen.message, 120)}`, reason: "A confirm or prompt dialog opened. It was dismissed." },
            info: "Re-run with allow_irreversible: true only if the user wants the dialog accepted.",
          });
        }
      }

      lastSnap = await snapshot(page);
      lastResult = snap.url !== lastSnap.url ? `navigated to ${lastSnap.url}` : "page updated";
    }

    return finish(statusOnBudget(lastGoal, "max_steps"), lastSnap, { candidates: lastGoal !== null && lastGoal >= 0.6 ? undefined : topLabels(rankCandidates(lastSnap.candidates)) });
  } finally {
    page.off("dialog", onDialog);
  }
}

// ── Page operations ─────────────────────────────────────────────────────────

async function snapshot(page: Page): Promise<RawSnapshot> {
  try {
    return await page.evaluate(collectSnapshot, { maxText: DEFAULT_TEXT_CHARS * 2, maxCandidates: 2_000 });
  } catch (error) {
    // A navigation mid-evaluate throws; wait briefly and try once more.
    await page.waitForNetworkIdle({ idleTime: 200, timeout: 2_000 }).catch(() => {});
    try {
      return await page.evaluate(collectSnapshot, { maxText: DEFAULT_TEXT_CHARS * 2, maxCandidates: 2_000 });
    } catch {
      throw error;
    }
  }
}

async function settle(page: Page, idleTime: number): Promise<void> {
  if (idleTime <= 0) return;
  await page.waitForNetworkIdle({ idleTime, timeout: DEFAULT_SETTLE_CAP_MS }).catch(() => {});
}

type Resolved = { element: ElementHandle<Element>; option?: undefined } | { element: null; option: { select: ElementHandle<HTMLSelectElement>; value: string } };

async function resolveRef(page: Page, ref: number): Promise<Resolved | null> {
  const kind = await page.evaluate((i: number) => {
    const r = window.__jevReach?.[i];
    if (!r) return "missing";
    return r instanceof Element ? "element" : "option";
  }, ref);
  if (kind === "missing") return null;
  if (kind === "element") {
    const handle = await page.evaluateHandle((i: number) => window.__jevReach?.[i] as Element, ref);
    const element = handle.asElement();
    if (!element) return null;
    return { element: element as ElementHandle<Element> };
  }
  const selectHandle = await page.evaluateHandle((i: number) => (window.__jevReach?.[i] as { select: HTMLSelectElement }).select, ref);
  const select = selectHandle.asElement() as ElementHandle<HTMLSelectElement> | null;
  const value = await page.evaluate((i: number) => (window.__jevReach?.[i] as { value: string }).value, ref);
  if (!select) return null;
  return { element: null, option: { select, value } };
}

async function act(page: Page, decision: Extract<Decision, { kind: "act" }>, values: Record<string, string>): Promise<{ stale: boolean }> {
  switch (decision.action) {
    case "scroll_down":
      await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8)));
      return { stale: false };
    case "scroll_up":
      await page.evaluate(() => window.scrollBy(0, -Math.round(window.innerHeight * 0.8)));
      return { stale: false };
    case "back":
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => {});
      return { stale: false };
    case "wait":
      await new Promise((r) => setTimeout(r, 1_000));
      return { stale: false };
    default:
      break;
  }

  const target = decision.target;
  if (!target) return { stale: true };
  const resolved = await resolveRef(page, target.ref);
  if (!resolved) return { stale: true };

  if (decision.action === "select") {
    if (!resolved.option) return { stale: true };
    await resolved.option.select.select(resolved.option.value);
    await resolved.option.select.dispose();
    return { stale: false };
  }

  const el = resolved.element;
  if (!el) return { stale: true };
  try {
    await el.scrollIntoView().catch(() => {});
    if (decision.action === "type") {
      const value = decision.valueKey !== undefined ? values[decision.valueKey] : undefined;
      if (value === undefined) return { stale: true };
      await el.click({ count: 3 }).catch(() => {});
      await el.evaluate((e) => {
        const f = e as HTMLInputElement | HTMLTextAreaElement | HTMLElement;
        if ("value" in f && typeof f.value === "string") f.value = "";
        else if ((f as HTMLElement).isContentEditable) (f as HTMLElement).textContent = "";
      }).catch(() => {});
      await el.type(value, { delay: 5 });
      return { stale: false };
    }
    await el.click();
    return { stale: false };
  } finally {
    await el.dispose().catch(() => {});
  }
}

// ── Small formatters ────────────────────────────────────────────────────────

function describeTarget(c: Candidate): string {
  return `${c.tag} "${truncate(c.label, 60)}"`;
}

function describeDecision(d: Decision): string {
  switch (d.kind) {
    case "finish":
      return `finish ${d.status}`;
    case "act":
      return d.target ? `${d.action} ${describeTarget(d.target)}` : d.action;
    case "confirm":
      return `withhold ${d.action} ${describeTarget(d.target)}`;
    default:
      return `${d.kind}: ${d.reason}`;
  }
}
