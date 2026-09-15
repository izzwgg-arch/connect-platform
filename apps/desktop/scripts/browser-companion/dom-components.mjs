/** COMPONENT evidence in isolated installed Chrome, never substituted for Coworker chat acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {portal} from "./portal.mjs";
import {pageOperation} from "../../browser-companion/page.js";
const modulePath=path.resolve(process.argv[2] || "scratchpad/browser-companion-toolchain/node_modules/playwright/index.mjs");
const {chromium}=await import(pathToFileURL(modulePath));
const out=path.resolve(process.argv[3] || "scratchpad/browser-companion-component-proof");await fs.mkdir(out,{recursive:true});
const site=portal({port:0,logFile:path.join(out,"portal-events.jsonl")});const address=await site.start();const base=`http://127.0.0.1:${address.port}`;
const browser=await chromium.launch({channel:"chrome",headless:true,chromiumSandbox:true});
const results=[];
async function check(name,fn){const start=performance.now();try{await fn();results.push({name,status:"PASS",ms:Math.round(performance.now()-start),kind:"COMPONENT_NOT_AGENT_ACCEPTANCE"});}catch(e){results.push({name,status:"FAIL",error:e.message,kind:"COMPONENT_NOT_AGENT_ACCEPTANCE"});}}
try {
  const context=await browser.newContext();const page=await context.newPage();
  const operation=(op,args={})=>page.evaluate(({source,op,args})=>globalThis.__testOperation(op,args),{source:null,op,args});
  await context.addInitScript(`globalThis.__testOperation = ${pageOperation.toString()}`);
  const visit=p=>page.goto(base+p);
  await check("form exact values and password redaction",async()=>{
    await visit("/form");let read=await operation("read");assert.ok(!JSON.stringify(read).includes("FAKE_ONLY"));
    const ref=name=>read.elements.find(e=>e.name===name)?.ref;
    await operation("act",{action:"fill",ref:ref("Name"),value:"Jacob"});
    await operation("act",{action:"select",ref:ref("Choice"),value:"Option B"});
    await operation("act",{action:"check",ref:ref("Agreement"),checked:true});
    await Promise.all([page.waitForURL("**/submit"),operation("act",{action:"click",ref:ref("Submit")})]);
    assert.deepEqual(site.events.find(e=>e.action==="form").values,{name:"Jacob",choice:"Option B",agreement:"yes"});
  });
  await check("10000-row table bounded extraction and exact Customer 73 amount",async()=>{
    await visit("/table?rows=10000");const read=await operation("read",{query:"Customer 73",limit:100});
    assert.deepEqual(read.tables[0].rows.find(r=>r[0]==="Customer 73"),["Customer 73","9125"]);
    assert.ok(JSON.stringify(read).length<60000);
  });
  await check("dynamic UI action verified",async()=>{
    await visit("/dynamic");const read=await operation("read");await operation("act",{action:"click",ref:read.elements.find(e=>e.name==="Load details").ref});
    await page.getByText("Dynamic success").waitFor();
  });
  await check("CSS-hidden text and private regions are excluded",async()=>{
    await visit("/form");await page.evaluate(()=>{const div=document.createElement("div");div.innerHTML='<div style="display:none">HIDDEN_SECRET_123</div><span data-private>PRIVATE_SECRET_123</span>';document.body.append(div);});
    const read=await operation("read");assert.ok(!JSON.stringify(read).includes("SECRET_123"));
  });
  await check("approval detects changed form data and changed link destinations",async()=>{
    await visit("/form");const read=await operation("read"),ref=read.elements.find(e=>e.name==="Submit").ref;
    const snapshot=await operation("describe",{ref});
    await page.locator('[name="name"]').fill("Changed after approval");
    await assert.rejects(operation("act",{ref,action:"click",expectedBinding:snapshot.binding}),/page_changed_after_approval/);
    assert.ok(!site.events.some(e=>e.values?.name==="Changed after approval"));
    await visit("/reports");const links=await operation("read"),link=links.elements.find(e=>e.role==="link");
    await page.locator("a").first().evaluate(e=>e.href="/different-destination");
    await assert.rejects(operation("downloadTarget",{ref:link.ref}),/stale_or_ambiguous/);
  });
  await check("modal is represented",async()=>{
    await visit("/modal");const read=await operation("read");await operation("act",{action:"click",ref:read.elements.find(e=>e.name==="Open dialog").ref});
    assert.ok((await operation("read")).elements.some(e=>e.role==="dialog"));
  });
  await check("reference relocates after DOM node replacement",async()=>{
    await visit("/changing");const read=await operation("read");const ref=read.elements.find(e=>e.name==="Stable action").ref;
    await page.waitForTimeout(1700);await operation("act",{action:"click",ref});assert.ok((await operation("read")).text.includes("Changed DOM success"));
  });
  await check("stale reference across navigation fails closed",async()=>{
    const read=await operation("read");const ref=read.elements[0].ref;await visit("/form");await assert.rejects(operation("act",{action:"click",ref}),/stale_reference/);
  });
  await check("injection text is returned as untrusted; read performs no upload",async()=>{
    await visit("/injection");const read=await operation("read");assert.equal(read.trust,"untrusted_page_data");assert.ok(read.text.includes("$42.00"));assert.ok(!site.events.some(e=>e.action==="upload"));
  });
  await check("parallel page input remains unchanged during DOM operations",async()=>{
    const userPage=await context.newPage();await userPage.goto(base+"/form");await userPage.locator('[name="name"]').fill("User typing here");
    await visit("/form");const read=await operation("read");await operation("act",{action:"fill",ref:read.elements.find(e=>e.name==="Name").ref,value:"Coworker"});
    assert.equal(await userPage.locator('[name="name"]').inputValue(),"User typing here");await userPage.close();
  });
  await page.screenshot({path:path.join(out,"component-form.png")});
} finally {await browser.close();await new Promise(resolve=>site.server.close(resolve));await fs.writeFile(path.join(out,"component-tests.json"),JSON.stringify({browser:"installed Chrome; isolated headless profile",agentDriven:false,results},null,2));}
console.log(JSON.stringify(results,null,2));if(results.some(r=>r.status!=="PASS"))process.exitCode=1;
