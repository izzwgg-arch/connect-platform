const $=id=>document.getElementById(id);
async function message(type,extra={}) { const r=await chrome.runtime.sendMessage({type,...extra}); $("status").textContent=r.ok ? `${r.running?"Connected":"Disconnected"} · ${r.paused?"Paused":"Ready"} · ${r.tabs} assigned tabs` : r.error; if(r.tasks){$("task").replaceChildren(...r.tasks.map(t=>{const o=document.createElement("option");o.value=t;o.textContent=t;return o;}));} return r; }
for(const type of ["pause","stop","resume"]) $(type).onclick=()=>message(type).catch(e=>$("status").textContent=e.message);
$("pair").onclick=async()=>{await message("pair",{secret:$("secret").value.trim()});$("secret").value="";};
$("grant").onclick=async()=>{try{const u=new URL($("origin").value);if(!["https:","http:"].includes(u.protocol)||u.username||u.password)throw Error("Enter an HTTP or HTTPS site.");const granted=await chrome.permissions.request({origins:[`${u.origin}/*`]});$("status").textContent=granted?`Allowed ${u.origin}`:"Site permission declined";}catch(e){$("status").textContent=e.message;}};
$("debugger").onclick=async()=>{$("status").textContent=await chrome.permissions.request({permissions:["debugger"]})?"Screenshots and uploads enabled":"Permission declined";};
$("share").onclick=()=>message("share",{taskId:$("task").value});
void message("status");
