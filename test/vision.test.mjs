import assert from 'node:assert/strict';
import test from 'node:test';
import { askStep, newUsage } from '../dist/jev.js';
import { payload, withClient } from './helpers.mjs';

test('the navigation step includes an actual image object and opt-in only for visual state', async () => {
  let captured;
  const sdk = { systemOne: async (body, options) => {
    captured = { body, options };
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      answers[id] = q.type === 'choice'
        ? { type: 'choice', choice: id === 'action' ? 'wait' : 'none', confidence: .99 }
        : { type: 'noul', noul: .01 };
    }
    return { answers, usage: { input_tokens: null, output_tokens: 10 } };
  } };
  const state = { goal: 'inspect a rectangle', step: 1, url: 'http://fixture/', title: 'fixture', page_text: '',
    last_action: '', last_result: '', available_values: [], element_count: 0 };
  const usage = newUsage();
  await askStep(sdk, state, [], [], usage);
  assert.equal(captured.options.headers, undefined);
  assert.equal(usage.input_tokens, null);
  await askStep(sdk, { ...state, screenshot: Buffer.from('synthetic image bytes for the injected SDK') }, [], [], usage);
  assert.equal(captured.options.headers['TypeSafe-Danger-Zone-Images'], 'true');
  assert.equal(typeof captured.body.state.screenshot, 'object');
  assert.equal(usage.input_tokens, null, 'unknown usage must not become a zero-token success');
});

test('visual navigation refuses supplied values before browser or model access', async () => {
  await withClient({}, async client => {
    const result = await client.callTool({ name: 'reach', arguments: { goal: 'fill a form', vision: true, values: { email: 'synthetic@example.test' } } });
    assert.equal(result.isError, true);
    assert.match(payload(result).error, /supplied values/);
  });
});
