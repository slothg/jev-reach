/**
 * Narrow existing-Chrome-MCP extension: real Canvas mouse input with bounded ticket validation and guaranteed release.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zod } from '../third_party/index.js';
import { ToolCategory } from './categories.js';
import { definePageTool } from './ToolDefinition.js';

const used = new WeakMap();

/**
 * Validate one CSS path before performing any input.
 * @param points Two to 128 viewport points with relative milliseconds.
 */
export function validatePoints(points, kind = 'drag') {
    if (kind === 'tap' && Array.isArray(points) && points.length === 1 && points[0].tMs === 0
        && Number.isFinite(points[0].x) && Number.isFinite(points[0].y) && points[0].x >= 0 && points[0].y >= 0) { return; }
    if (!Array.isArray(points) || points.length < 2 || points.length > 128 || points[0].tMs !== 0) {
        throw new Error('INPUT_CAPABILITY_MISSING: invalid point count or initial time');
    }
    let previousTime = -1;
    for (let i = 0, ilen = points.length; i < ilen; i++) {
        const point = points[i];
        if (![point.x, point.y, point.tMs].every(Number.isFinite) || point.x < 0 || point.y < 0 || point.tMs < previousTime) {
            throw new Error('GEOMETRY_UNSUPPORTED: invalid coordinates or time');
        }
        previousTime = point.tMs;
    }
    if (previousTime < 10 || previousTime > 2000) {
        throw new Error('BUDGET_EXCEEDED: path duration must be 10..2000ms');
    }
}

/**
 * Send an already validated path, releasing the mouse after any partial failure.
 * @param mouse Existing Puppeteer Page mouse, never a new browser.
 * @param points Validated viewport CSS points.
 * @returns Actual send stages with a required postcondition verification flag.
 */
export async function sendPath(mouse, points) {
    const stages = [];
    let pressed = false;
    try {
        await mouse.move(points[0].x, points[0].y);
        pressed = true;
        await mouse.down({ button: 'left' });
        stages.push('down');
        const started = performance.now();
        for (let i = 1, ilen = points.length; i < ilen; i++) {
            const waitMs = points[i].tMs - (performance.now() - started);
            if (waitMs > 0) {
                await new Promise(
                    /**
                     * Delay only this bounded path segment.
                     * @param resolve Timer completion callback.
                     */
                    resolve => setTimeout(resolve, waitMs));
            }
            await mouse.move(points[i].x, points[i].y);
            stages.push('move');
        }
        return { status: 'SENT', stages: stages, verificationRequired: true };
    } catch (error) {
        throw new Error(`ACTION_OUTCOME_UNKNOWN: partial path stages=${stages.join(',')}`, { cause: error });
    } finally {
        if (pressed) {
            try {
                await mouse.up({ button: 'left' });
                stages.push('up');
            } catch (error) {
                throw new Error('ACTION_OUTCOME_UNKNOWN: mouse release failed', { cause: error });
            }
        }
    }
}

export const qaPointerPath = definePageTool({
    name: 'qa_pointer_path',
    description: 'Send a fresh QA ticket through the existing Page mouse. Requires a claimed ticket and runtime binding.',
    annotations: { category: ToolCategory.INPUT, readOnlyHint: false },
    schema: {
        expectedRuntimeId: zod.string().min(1).max(128),
        actionId: zod.string().min(1).max(128),
        points: zod.array(zod.object({ x: zod.number().finite(), y: zod.number().finite(), tMs: zod.number().finite() }).strict()).min(1).max(128),
        ticket: zod.object({
            runtimeId: zod.string(), connectionEpoch: zod.number().int().positive(), sceneEpoch: zod.number().int().positive(),
            geometryVersion: zod.string().max(2048), expiresAtUnixMs: zod.number().finite(),
            target: zod.object({ testId: zod.string().optional(), handle: zod.string().optional(),
                generation: zod.number().int().optional(), businessKey: zod.string().optional() }).strict(),
            spec: zod.object({ kind: zod.enum(['tap', 'drag', 'long_press']), path: zod.array(zod.object({ x: zod.number(), y: zod.number() }).strict()).optional(),
                durationMs: zod.number().optional(), target: zod.record(zod.string(), zod.unknown()).optional() }).strict(),
        }).strict(),
        button: zod.literal('left').default('left'),
        includeSnapshot: zod.boolean().default(false),
    },
    blockedByDialog: true,
    verifyFilesSchema: { },
    /**
     * Validate runtime, scene, geometry, target and one-shot dispatch before sending real input.
     * @param request Existing page-scoped MCP request.
     * @param response Existing MCP response collector.
     */
    handler: async (request, response) => {
        const params = request.params;
        const page = request.page.pptrPage;
        validatePoints(params.points, params.ticket.spec.kind);
        if (params.expectedRuntimeId !== params.ticket.runtimeId || Date.now() >= params.ticket.expiresAtUnixMs) {
            throw new Error('GEOMETRY_STALE: expired ticket or runtime mismatch');
        }
        let actions = used.get(page);
        if (!actions) {
            actions = new Map();
            used.set(page, actions);
        }
        if (actions.has(params.actionId)) {
            throw new Error('ACTION_OUTCOME_UNKNOWN: action already dispatched');
        }
        for (const [id, expires] of actions) { if (expires < Date.now()) { actions.delete(id); } }
        if (actions.size >= 512) { throw new Error('BUSY: action journal capacity'); }
        actions.set(params.actionId, params.ticket.expiresAtUnixMs);
        const proof = await page.evaluate(
            /**
             * Call only the fixed trusted runtime validation API in the existing main world.
             * @param value Claimed ticket fields.
             * @returns Fresh runtime input validation.
             */
            value => window.__COCOS_QA__ ? window.__COCOS_QA__.validateInput(value) : { valid: false },
            { ...params.ticket, points: params.points });
        if (!proof.valid) {
            throw new Error('GEOMETRY_STALE: runtime rejected fresh input validation');
        }
        const result = await sendPath(page.mouse, params.points);
        response.appendResponseLine(JSON.stringify({ actionId: params.actionId, ...result }));
        if (params.includeSnapshot) {
            response.includeSnapshot();
        }
    },
});

const entries = new WeakMap();

export const qaPreviewInstall = definePageTool({
    name: 'qa_preview_install',
    description: 'Install a digest-checked local QA bundle in this existing preview tab and its subsequent documents.',
    annotations: { category: ToolCategory.INPUT, readOnlyHint: false },
    schema: {
        bundlePath: zod.string().min(1), sha256: zod.string().regex(/^[a-f0-9]{64}$/),
        expectedOrigin: zod.string().regex(/^http:\/\/(localhost|127\.0\.0\.1):[0-9]+$/),
    },
    blockedByDialog: true,
    verifyFilesSchema: {},
    /**
     * Attach only to the selected already-open Page, preserving browser and profile ownership.
     * @param request Existing page-scoped request.
     * @param response MCP response collector.
     */
    handler: async (request, response) => {
        const page = request.page.pptrPage;
        const params = request.params;
        if (new URL(page.url()).origin !== params.expectedOrigin) {
            throw new Error('PROJECT_MISMATCH: selected Page origin');
        }
        const source = await readFile(params.bundlePath, 'utf8');
        if (Buffer.byteLength(source) > 512 * 1024 || createHash('sha256').update(source).digest('hex') !== params.sha256
            || !source.startsWith('/** Trusted QA-only bundle loader;')) {
            throw new Error('AUTH_REQUIRED: untrusted or oversized QA bundle');
        }
        const entry = `(function(){const origin=${JSON.stringify(params.expectedOrigin)};const deadline=Date.now()+15000;
            function start(){if(location.origin!==origin){return;}if(window.cc&&cc.ENGINE_VERSION==='2.4.15'&&cc.director.getScene()){
                if(window.__COCOS_QA__&&window.__COCOS_QA_SOURCE__!==${JSON.stringify(params.sha256)}){
                    const saved=window.__COCOS_QA__.platform.readBootstrap();window.__COCOS_QA__.destroy();
                    window.__COCOS_QA__.platform.saveBootstrap(saved);delete window.__COCOS_QA__;}
                ${source}
                window.__COCOS_QA_SOURCE__=${JSON.stringify(params.sha256)};return;
            }if(Date.now()<deadline){setTimeout(start,100);}}start();})();`;
        const previous = entries.get(page);
        if (previous) { await page.removeScriptToEvaluateOnNewDocument(previous.identifier); }
        const installed = await page.evaluateOnNewDocument(entry);
        entries.set(page, installed);
        await page.evaluate(entry);
        response.appendResponseLine(JSON.stringify({installed: true, sha256: params.sha256, refreshEntry: true, pageReloaded: false}));
    },
});

export const qaPreviewRemove = definePageTool({
    name: 'qa_preview_remove', description: 'Remove only this MCP client owned new-document QA entry and runtime.',
    annotations: { category: ToolCategory.INPUT, readOnlyHint: false }, schema: {}, blockedByDialog: true, verifyFilesSchema: {},
    /**
     * Revoke credentials and the owned persistent Page script without closing the tab.
     * @param request Existing page-scoped request.
     * @param response MCP response collector.
     */
    handler: async (request, response) => {
        const page = request.page.pptrPage;
        const installed = entries.get(page);
        if (installed) { await page.removeScriptToEvaluateOnNewDocument(installed.identifier); entries.delete(page); }
        await page.evaluate(
            /** Remove the explicitly owned independent runtime. */
            () => {if(window.__COCOS_QA__){window.__COCOS_QA__.destroy();delete window.__COCOS_QA__;}});
        response.appendResponseLine(JSON.stringify({removed: true, pageClosed: false}));
    },
});
