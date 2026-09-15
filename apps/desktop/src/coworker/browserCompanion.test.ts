import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sign, verify, validateArgs, safeUrl, PROTOCOL } from "./browserCompanion/protocol";
import { BrowserCompanionBridge } from "./browserCompanion/bridge";
import { CHROME_TOOLS } from "./browserCompanion/catalog";
import { decideToolCall } from "./policyCore";

const secret=randomBytes(32).toString("hex"), extensionId="abcdefghijklmnopabcdefghijklmnop";
test("protocol authenticates both directions, expires, rejects tamper and version confusion",()=>{
  const p=sign(secret,"extension",{type:"poll"});
  assert.equal(verify(secret,"extension",p),true);
  assert.equal(verify(secret,"desktop",p),false);
  assert.equal(verify(randomBytes(32).toString("hex"),"extension",p),false);
  for(const changed of [{body:'{"type":"command"}'},{version:PROTOCOL+1},{nonce:"bad"},{mac:"x"},{time:p.time-60000},{extra:true}]) assert.equal(verify(secret,"extension",{...p,...changed}),false);
});
test("typed command boundary rejects scripts, credential URLs, malformed targets and extra authority",()=>{
  for(const u of ["javascript:alert(1)","file:///C:/Windows/test","https://user:password@example.com","chrome://settings/"]) assert.throws(()=>safeUrl(u));
  assert.equal(safeUrl("https://example.com"),"https://example.com/");
  for(const a of [{tabId:1,script:"alert(1)"},{tabId:-1},{tabId:1,value:{}},{tabId:1,action:"eval"}]) assert.throws(()=>validateArgs("act",a));
  assert.throws(()=>validateArgs("read",{}));
  assert.throws(()=>validateArgs("upload",{tabId:1,ref:"r1"}));
  assert.doesNotThrow(()=>validateArgs("act",{tabId:1,action:"fill",ref:"r1",value:"Jacob"}));
  for (const args of [{tabId:1,action:"fill",ref:"r1",value:true},{tabId:1,action:"check",ref:"r1",checked:"false"},{tabId:1,action:"click",ref:""},{tabId:1,action:"click",ref:"r1",value:"injected"}]) assert.throws(()=>validateArgs("act",args));
  assert.doesNotThrow(()=>validateArgs("act",{tabId:1,action:"scroll",y:-500}));
  assert.throws(()=>validateArgs("constructor" as any,{}));
  assert.throws(()=>validateArgs("wait",{tabId:1,text:""}));
  assert.throws(()=>validateArgs("read",{tabId:1,limit:201}));
});
test("every outward Chrome action requires local approval under ALL profiles",()=>{
  for(const tool of CHROME_TOOLS.filter(t=>t.spec.exfiltrationCapable)) for(const profile of ["SAFE","TRUSTED","AUTONOMOUS"] as const) {
    const permissions={profile,overrides:{}};
    assert.equal(decideToolCall({spec:tool.spec,permissions,provenance:"user"}).verdict,"ask",`${profile}:${tool.name}`);
    assert.equal(decideToolCall({spec:tool.spec,permissions,provenance:"external"}).verdict,"deny");
  }
});
test("real loopback bridge rejects outsiders, fake origin, replay and malformed messages; correlates commands and stops",async()=>{
  const bridge=new BrowserCompanionBridge({secret,extensionId,port:0}); await bridge.start();
  try {
    const address=`http://127.0.0.1:${bridge.status().port}/exchange`;
    const send=(p:unknown,origin=`chrome-extension://${extensionId}`)=>fetch(address,{method:"POST",headers:{"Content-Type":"application/json",Origin:origin},body:JSON.stringify(p)});
    assert.equal((await send(sign(secret,"extension",{type:"poll"}),"https://evil.example")).status,403);
    assert.equal((await send(sign("f".repeat(64),"extension",{type:"poll"}))).status,401);
    assert.equal((await send({version:1})).status,401);
    const hello=sign(secret,"extension",{type:"result",id:"nonexistent",result:{ok:true}});
    const response=await send(hello); assert.equal(response.status,200);
    const signed=await response.json(); assert.equal(verify(secret,"desktop",signed),true);
    const boot=JSON.parse(signed.body).boot;
    assert.equal((await send(hello)).status,401);
    const operation=bridge.execute("read",{tabId:7},"task1",new AbortController().signal,"conversation1");
    const polled=await (await send(sign(secret,"extension",{type:"poll"}))).json();
    const [cmd]=JSON.parse(polled.body).commands;
    assert.equal(cmd.command,"read"); assert.equal(cmd.scopeId,"conversation1");
    await send(sign(secret,"extension",{type:"result",boot,id:cmd.id,result:{ok:true,title:"Proof"}}));
    assert.deepEqual(await operation,{ok:true,title:"Proof"});
    const abort=new AbortController(), cancelled=bridge.execute("wait",{tabId:7,text:"Done"},"task2",abort.signal);
    abort.abort(); assert.equal((await cancelled).error,"task_cancelled");
    await send(sign(secret,"extension",{type:"stop"}));
    assert.equal((await bridge.execute("read",{tabId:7},"task3",new AbortController().signal)).error,"browser_stopped");
  } finally { await bridge.stop(); }
});
