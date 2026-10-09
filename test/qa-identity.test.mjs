/** Bounded target identity and enrollment ownership checks for the maintained QA extension. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {qaPageIdentity, qaPreviewInstall, qaPreviewRemove} from '../node_modules/chrome-devtools-mcp/build/src/tools/qa-pointer-path.js';

test('physical target identity is stable across client aliases and isolated across browsers', async () => {
  const identity = async (pageId, endpoint) => {
    let detached = 0;
    const page = {createCDPSession: async () => ({send: async name => {
      assert.equal(name, 'Target.getTargetInfo'); return {targetInfo: {type:'page', targetId:'physical'}};
    }, detach: async () => {detached++;}}), browser: () => ({wsEndpoint: () => endpoint}),
    evaluate: async () => ({origin:'http://localhost:7456', engineVersion:'2.4.15'})};
    let result;
    await qaPageIdentity.handler({page: {pptrPage: page}, params: {pageId}}, {appendResponseLine: line => {result=JSON.parse(line);}});
    assert.equal(detached, 1);
    return result.targetKey;
  };
  assert.equal(await identity(1, 'ws://browser/a'), await identity(99, 'ws://browser/a'));
  assert.notEqual(await identity(1, 'ws://browser/a'), await identity(1, 'ws://browser/b'));
});

test('temporary CDP session is detached after a metadata failure', async () => {
  let detached=0;
  const page={createCDPSession: async () => ({send:async()=>{throw Error('target lost');},detach:async()=>{detached++;}})};
  await assert.rejects(qaPageIdentity.handler({page:{pptrPage:page}}, {}), /target lost/);
  assert.equal(detached,1);
});

test('entry removal rejects a foreign enrollment and retains a runtime with another bootstrap', async () => {
  const bundlePath=fileURLToPath(new URL('./fixtures/qa-bundle.js',import.meta.url));
  const sha256=createHash('sha256').update(await readFile(bundlePath)).digest('hex');
  let removes=0, destroys=0;
  const page={url:()=> 'http://localhost:7456/', evaluateOnNewDocument:async()=>({identifier:'owned-script'}),
    removeScriptToEvaluateOnNewDocument:async()=>{removes++;}, evaluate:async(fn,argument)=>{
      if(typeof fn==='string')return;
      const previous=globalThis.window;
      globalThis.window={__COCOS_QA__:{platform:{readBootstrap:()=>({sessionId:'new-owner'})},destroy:()=>{destroys++;}}};
      try{return fn(argument);}finally{globalThis.window=previous;}
    }};
  const response={appendResponseLine:()=>{}};
  const request={page:{pptrPage:page},params:{bundlePath,sha256,expectedOrigin:'http://localhost:7456',ownerId:'first',ownerExpiresAtUnixMs:Date.now()+10000}};
  await qaPreviewInstall.handler(request,response);
  await assert.rejects(qaPreviewInstall.handler({...request,params:{...request.params,ownerId:'foreign'}},response), /SESSION_BUSY/);
  await qaPreviewRemove.handler({page:{pptrPage:page},params:{ownerId:'foreign'}},response);
  assert.equal(removes,0);
  await qaPreviewRemove.handler({page:{pptrPage:page},params:{ownerId:'first'}},response);
  assert.equal(removes,1);
  assert.equal(destroys,0);
});

test('an expired abandoned entry can be replaced while its previous runtime is removed by owner', async () => {
  const bundlePath=fileURLToPath(new URL('./fixtures/qa-bundle.js',import.meta.url));
  const sha256=createHash('sha256').update(await readFile(bundlePath)).digest('hex');
  const originalNow=Date.now, originalWindow=globalThis.window;
  let now=1000000, removes=0, destroys=0, installs=0;
  Date.now=()=>now;
  globalThis.window={__COCOS_QA__:{platform:{readBootstrap:()=>({sessionId:'old'})},destroy:()=>{destroys++;}}};
  const page={url:()=> 'http://localhost:7456/', evaluateOnNewDocument:async()=>({identifier:`script-${++installs}`}),
    removeScriptToEvaluateOnNewDocument:async()=>{removes++;}, evaluate:async(fn,arg)=>typeof fn==='function'?fn(arg):undefined};
  const response={appendResponseLine:()=>{}};
  const request={page:{pptrPage:page},params:{bundlePath,sha256,expectedOrigin:'http://localhost:7456',ownerId:'old',ownerExpiresAtUnixMs:now+1}};
  try {
    await qaPreviewInstall.handler(request,response);
    now+=2;
    await qaPreviewInstall.handler({...request,params:{...request.params,ownerId:'new',ownerExpiresAtUnixMs:now+10000}},response);
    assert.equal(installs,2); assert.equal(removes,1); assert.equal(destroys,1);
  } finally {Date.now=originalNow; globalThis.window=originalWindow;}
});
