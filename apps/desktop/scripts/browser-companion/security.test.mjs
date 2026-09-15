import test from "node:test";
import assert from "node:assert/strict";
import {ApprovalBook} from "../../browser-companion/approvals.js";
import {validateArgs} from "../../browser-companion/schema.js";
import {packet,verified} from "../../browser-companion/crypto.js";
const item={taskId:"turn1",scopeId:"chat1",command:"act",args:{tabId:2,ref:"button1",action:"click"}};
test("approval is one-use and bound to exact task, tab, operation, arguments and document",()=>{
  const book=new ApprovalBook(),snapshot={binding:"document:1:form:42"};
  for (const change of [{taskId:"turn2"},{scopeId:"chat2"},{command:"upload"},{args:{...item.args,tabId:3}},{args:{...item.args,ref:"button2"}}]) {
    const authorization=book.issue(item,snapshot,100);
    assert.throws(()=>book.consume({...item,...change,authorization},snapshot,101),/approval_missing/);
  }
  let authorization=book.issue(item,snapshot,100);
  assert.throws(()=>book.consume({...item,authorization},{binding:"document:2:form:42"},101),/approval_missing/);
  authorization=book.issue(item,snapshot,100);
  assert.throws(()=>book.consume({...item,authorization},snapshot,120101),/approval_missing/);
  authorization=book.issue(item,snapshot,100);
  assert.equal(book.consume({...item,authorization},snapshot,101),snapshot.binding);
  assert.throws(()=>book.consume({...item,authorization},snapshot,102),/approval_missing/);
});
test("extension validates exact argument types and exposes no script or approval primitive",()=>{
  for(const command of ["eval","constructor","__proto__"]) assert.throws(()=>validateArgs(command,{}));
  for(const args of [{...item.args,authorization:"fake"},{...item.args,script:"alert(1)"},{...item.args,checked:"false"},{tabId:1,action:"fill",ref:"r",value:false}]) assert.throws(()=>validateArgs("act",args));
  assert.doesNotThrow(()=>validateArgs("act",{tabId:1,action:"scroll",y:-100}));
});
test("extension verifies desktop HMAC direction and request challenge",async()=>{
  const secret="a".repeat(64),nonce="b".repeat(48),signed=await packet(secret,"desktop",{ok:true},nonce);
  assert.deepEqual(await verified(secret,signed,nonce),{ok:true});
  await assert.rejects(verified(secret,signed,"c".repeat(48)),/untrusted/);
  await assert.rejects(verified(secret,{...signed,body:'{"ok":false}'},nonce),/untrusted/);
  await assert.rejects(verified(secret,await packet(secret,"extension",{ok:true},nonce),nonce),/untrusted/);
});
