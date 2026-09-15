import { packet, verified } from "./crypto.js";
import { pageOperation } from "./page.js";
import { validateArgs } from "./schema.js";
import { ApprovalBook, protectedCommands } from "./approvals.js";

const commands = new Set(["tabs","open","read","act","download","upload","screenshot","wait","close"]);
let running = false, paused = false, boot = null, cfg = null;
let owned = {}, active = new Map(), cancelledTasks = new Set();
const approvals = new ApprovalBook(), completed = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = (async () => {
  await chrome.storage.local.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"});
  await chrome.storage.session.setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"});
  const saved = await chrome.storage.session.get(["owned","paused","boot","completed"]);
  owned = saved.owned || {}; paused = saved.paused ?? true; boot = saved.boot || null;
  for (const id of saved.completed || []) completed.add(id);
})();
const persist = () => chrome.storage.session.set({owned,paused,boot});
const publicUrl = value => { try { const u=new URL(value); return u.origin+u.pathname; } catch { return ""; } };
const url = value => { const u=new URL(value); if (!["http:","https:"].includes(u.protocol)||u.username||u.password) throw Error("unsafe_url"); return u.href; };
async function exchange(body) {
  const p = await packet(cfg.secret,"extension",body);
  const response = await fetch(`http://127.0.0.1:${cfg.port}/exchange`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p),signal:AbortSignal.timeout(25000),credentials:"omit",cache:"no-store",redirect:"error"});
  if (!response.ok) throw Error(`bridge_http_${response.status}`);
  const text = await response.text(); if (text.length>2*1024*1024) throw Error("oversized_bridge_response");
  return verified(cfg.secret,JSON.parse(text),p.nonce);
}
async function badge(tabId, text) { await chrome.action.setBadgeText({tabId,text}); await chrome.action.setBadgeBackgroundColor({tabId,color:paused?"#9a6700":"#1269c7"}); }
async function target(item) {
  const record=owned[item.args.tabId];
  if (!record || record.taskId!==item.scopeId || !["COWORKER","SHARED"].includes(record.owner)) throw Error("tab_not_owned_by_task");
  if (record.paused) throw Error("tab_paused_by_user");
  const tab=await chrome.tabs.get(item.args.tabId);
  url(tab.url);
  if (tab.incognito) throw Error("incognito_not_supported");
  if (new URL(tab.url).origin!==record.origin) throw Error("origin_changed_reauthorize_in_popup");
  if (!await chrome.permissions.contains({origins:[`${record.origin}/*`]})) throw Error("site_permission_required_in_popup");
  return tab;
}
function checkpoint(item) { if (paused || active.get(item.id)?.aborted || cancelledTasks.has(item.taskId) || Date.now()>item.expires) throw Error("browser_paused_cancelled_or_expired"); }
async function inject(item, op, args=item.args) {
  checkpoint(item); const tab=await target(item);
  checkpoint(item);
  const result=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"ISOLATED",func:pageOperation,args:[op,{...args,expectedOrigin:owned[tab.id].origin,...(item.binding?{expectedBinding:item.binding}:{})}]});
  if (!result[0]?.result) throw Error("page_execution_failed"); return result[0].result;
}
async function settled(item) {
  const until=Date.now()+15000;
  while (Date.now()<until) { checkpoint(item); const tab=await chrome.tabs.get(item.args.tabId); if (tab.status==="complete") return; await sleep(150); }
  throw Error("navigation_timeout");
}
async function debuggerCall(item, work) {
  if (!await chrome.permissions.contains({permissions:["debugger"]})) throw Error("optional_debugger_permission_required_in_popup");
  await target(item); checkpoint(item);
  const handle={tabId:item.args.tabId};
  await chrome.debugger.attach(handle,"1.3");
  try { checkpoint(item); return await work((method,params={})=>chrome.debugger.sendCommand(handle,method,params)); }
  finally { await chrome.debugger.detach(handle).catch(()=>{}); }
}
async function execute(item) {
  if (!item || !commands.has(item.command) || typeof item.id!=="string" || typeof item.taskId!=="string" || item.taskId.length>200 || typeof item.scopeId!=="string" || !item.scopeId || item.scopeId.length>200 || !["prepare","execute"].includes(item.phase) || !Number.isSafeInteger(item.expires) || item.expires>Date.now()+180000 || !item.args || Array.isArray(item.args)) throw Error("malformed_command");
  validateArgs(item.command,item.args);
  checkpoint(item);
  if (protectedCommands.has(item.command)) {
    const snapshot = item.command==="open" ? {binding:url(item.args.url),description:{destination:url(item.args.url)}} : await inject(item,"describe");
    if (item.phase==="prepare") return {ok:true,authorization:approvals.issue(item,snapshot),description:snapshot.description};
    item.binding=approvals.consume(item,snapshot);
  } else if (item.phase!=="execute") throw Error("unexpected_prepare");
  if (item.command==="tabs") {
    const tabs=[]; for(const [id,record] of Object.entries(owned)) if(record.taskId===item.scopeId) { const t=await chrome.tabs.get(Number(id)).catch(()=>null); if(t) tabs.push({tabId:t.id,owner:record.owner,url:publicUrl(t.url),title:t.title,paused:record.paused}); }
    return {ok:true,tabs};
  }
  if (item.command==="open") {
    const destination=url(item.args.url), origin=new URL(destination).origin;
    if (!await chrome.permissions.contains({origins:[`${origin}/*`]})) return {ok:false,error:"site_permission_required_in_popup",origin};
    checkpoint(item);
    if (Object.keys(owned).length>=50) throw Error("owned_tab_limit");
    const tab=await chrome.tabs.create({url:destination,active:false});
    owned[tab.id]={owner:"COWORKER",taskId:item.scopeId,origin,paused:false}; await persist(); await badge(tab.id,"AI");
    item.args={tabId:tab.id}; delete item.binding; await settled(item); await inject(item,"interference");
    return {...await inject(item,"read"),tabId:tab.id,owner:"COWORKER"};
  }
  await target(item);
  if (item.command==="read") return {...await inject(item,"read"),tabId:item.args.tabId};
  if (item.command==="act") { const result=await inject(item,"act"); delete item.binding; await sleep(200); await settled(item); return {...result,page:await inject(item,"read"),tabId:item.args.tabId}; }
  if (item.command==="wait") {
    const end=Date.now()+Math.min(30000,Number(item.args.timeoutMs)||15000);
    while(Date.now()<end) { if((await inject(item,"wait")).found) return {ok:true,found:true}; await sleep(250); }
    throw Error("page_wait_timeout");
  }
  if (item.command==="close") { checkpoint(item); await chrome.tabs.remove(item.args.tabId); delete owned[item.args.tabId]; await persist(); return {ok:true,closed:item.args.tabId}; }
  if (item.command==="download") {
    const link=await inject(item,"downloadTarget");
    if(new URL(link.url).origin!==owned[item.args.tabId].origin) throw Error("cross_origin_download_requires_separate_authorization");
    checkpoint(item);
    const filename=(new URL(link.url).pathname.split("/").pop() || "report").replace(/[^a-zA-Z0-9._-]/g,"_").replace(/^\.+/,"").slice(0,100) || "report";
    const id=await chrome.downloads.download({url:link.url,filename:`LoopcomCoworker/${crypto.randomUUID()}/${filename}`,conflictAction:"uniquify",saveAs:false});
    try {
      while(Date.now()<item.expires) {
        checkpoint(item); const [download]=await chrome.downloads.search({id});
        if(!download || download.state==="interrupted" || (download.danger && download.danger!=="safe" && download.danger!=="accepted")) throw Error("download_failed_or_requires_user_review");
        if(download.state==="complete" && download.exists) return {ok:true,downloadId:id,path:download.filename,bytes:download.fileSize,state:"complete"};
        await sleep(250);
      }
      throw Error("download_timeout");
    } catch(e) { await chrome.downloads.cancel(id).catch(()=>{}); throw e; }
  }
  if (item.command==="upload") {
    const found=await inject(item,"fileTarget");
    return debuggerCall(item,async send=>{
      const {root}=await send("DOM.getDocument",{depth:0});
      const {nodeId}=await send("DOM.querySelector",{nodeId:root.nodeId,selector:found.selector});
      if(!nodeId) throw Error("upload_target_changed");
      checkpoint(item); await send("DOM.setFileInputFiles",{nodeId,files:[item.args.path]});
      return {ok:true,selected:true,verification:"File selected. Read page and submit only after local approval; server receipt is separate proof."};
    });
  }
  if (item.command==="screenshot") {
    return debuggerCall(item,async send=>{
      const shot=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
      if(!shot.data || shot.data.length>1300000) throw Error("screenshot_too_large");
      return {ok:true,png:shot.data};
    });
  }
  throw Error("unimplemented_command");
}
async function processItem(item) {
  if (completed.has(item.id)) { await exchange({type:"result",boot,id:item.id,result:{ok:false,error:"duplicate_command_inspect_before_retry"}}).catch(()=>{}); return; }
  const abort={aborted:false,taskId:item.taskId,tabId:item.args?.tabId}; active.set(item.id,abort);
  let result;
  try {
    // Persist BEFORE dispatch so a worker restart cannot repeat a submitted side effect.
    completed.add(item.id); if(completed.size>2048)completed.delete(completed.values().next().value);
    await chrome.storage.session.set({completed:[...completed]});
    result=await execute(item);
  } catch(e) { result={ok:false,error:String(e.message).slice(0,120)}; }
  finally { active.delete(item.id); }
  await exchange({type:"result",boot,id:item.id,result}).catch(()=>{}); // Lost ACK never replays a side effect.
}
async function connect() {
  await ready; if(running) return; cfg=(await chrome.storage.local.get("pairing")).pairing;
  if(!cfg || !/^[a-f0-9]{64}$/.test(cfg.secret) || cfg.port!==39174) return;
  running=true;
  try {
    while(true) {
      const reply=await exchange({type:"poll"});
      await chrome.storage.session.set({connectionError:null,connectedAt:Date.now()});
      if(reply.boot!==boot) { approvals.clear(); for(const rec of Object.values(owned)) rec.paused=true; boot=reply.boot; await persist(); }
      if(reply.stopped) paused=true;
      for(const item of reply.commands || []) {
        if(item.cancel) { const a=active.get(item.cancel); if(a)a.aborted=true; continue; }
        if(item.cancelTask) { approvals.clear(); if(item.cancelTask==="*") { for(const a of active.values())a.aborted=true; paused=true; } else { if(cancelledTasks.size>=1000)paused=true;else cancelledTasks.add(item.cancelTask); for(const a of active.values()) if(a.taskId===item.cancelTask)a.aborted=true; } continue; }
        if(active.size>=4 || [...active.values()].some(a=>a.tabId===item.args?.tabId && item.args?.tabId)) { await exchange({type:"result",boot,id:item.id,result:{ok:false,error:"browser_busy_retry_after_read"}}); continue; }
        void processItem(item); const a=active.get(item.id); if(a)a.tabId=item.args?.tabId;
      }
    }
  } catch(e) { await chrome.storage.session.set({connectionError:String(e.message).slice(0,100)}); }
  finally { running=false; for(const a of active.values())a.aborted=true; }
}
chrome.runtime.onMessage.addListener((msg,sender,respond)=>{
  if(sender.id!==chrome.runtime.id) return;
  if(sender.tab) {
    if(msg.type==="interaction" && owned[sender.tab.id]?.owner==="SHARED") { owned[sender.tab.id].paused=true; approvals.clear(); for(const a of active.values())if(a.tabId===sender.tab.id)a.aborted=true; void persist(); void badge(sender.tab.id,"II"); }
    return;
  }
  if(sender.url!==chrome.runtime.getURL("popup.html")) return;
  (async()=>{
    await ready;
    if(msg.type==="pair") { if(!/^[a-f0-9]{64}$/.test(msg.secret)) throw Error("invalid_pairing_code"); cfg={secret:msg.secret,port:39174}; await chrome.storage.local.set({pairing:cfg}); paused=false; await persist(); void connect(); }
    if(msg.type==="stop" || msg.type==="pause") { paused=true; approvals.clear(); for(const a of active.values())a.aborted=true; await persist(); if(cfg) await exchange({type:"stop"}).catch(()=>{}); }
    if(msg.type==="resume") { paused=false; for(const rec of Object.values(owned))rec.paused=false; await persist(); if(cfg)await exchange({type:"resume"}); void connect(); }
    if(msg.type==="share") {
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab || tab.incognito) throw Error("tab_unavailable"); url(tab.url);
      const task=Object.values(owned).find(r=>r.taskId===msg.taskId); if(!task) throw Error("select_existing_task");
      owned[tab.id]={owner:"SHARED",taskId:task.taskId,origin:new URL(tab.url).origin,paused:false}; await persist(); await badge(tab.id,"AI");
      await chrome.scripting.executeScript({target:{tabId:tab.id},world:"ISOLATED",func:pageOperation,args:["interference",{}]});
    }
    return {ok:true,running,paused,tasks:[...new Set(Object.values(owned).map(r=>r.taskId))],tabs:Object.keys(owned).length,error:(await chrome.storage.session.get("connectionError")).connectionError};
  })().then(respond,e=>respond({ok:false,error:String(e.message)})); return true;
});
chrome.tabs.onRemoved.addListener(tabId=>{delete owned[tabId]; void persist();});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==="complete" && owned[tabId]) void chrome.scripting.executeScript({target:{tabId},world:"ISOLATED",func:pageOperation,args:["interference",{}]}).catch(()=>{});});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==="reconnect")void connect();});
chrome.alarms.create("reconnect",{periodInMinutes:0.5});
void connect();
