/** Injected into Chrome's ISOLATED world on an assigned tab only. No eval, no page-to-native channel. */
export function pageOperation(op, args) {
  if (args.expectedOrigin && location.origin !== args.expectedOrigin) throw Error("origin_changed_before_action");
  const key = "__loopcomCompanionV1";
  const state = globalThis[key] ||= { refs: new Map(), next: 1 };
  const clean = (s, n = 250) => String(s || "").replace(/[\u0000-\u001f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g," ").trim().slice(0, n);
  const sensitive = e => e.matches('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete*="cc-"],input[type="hidden"]') || /password|passcode|secret|token|otp|credit.?card|security.?code/i.test(`${e.name || ""} ${e.id || ""} ${e.autocomplete || ""}`);
  const visible = e => !!(e.getClientRects().length) && getComputedStyle(e).visibility !== "hidden" && !e.closest('[aria-hidden="true"],[inert]');
  const labelText = label => { const clone=label.cloneNode(true); clone.querySelectorAll("input,select,textarea,script,style").forEach(e=>e.remove()); return clone.textContent; };
  const label = e => clean(e.getAttribute("aria-label") || (e.getAttribute("aria-labelledby") || "").split(/\s+/).map(id=>document.getElementById(id)?.textContent || "").join(" ").trim() || [...(e.labels || [])].map(labelText).join(" ") || e.getAttribute("placeholder") || (e.tagName === "INPUT" ? e.name : e.innerText) || e.title);
  const role = e => e.getAttribute("role") || ({ A:"link", BUTTON:"button", SELECT:"combobox", TEXTAREA:"textbox", TABLE:"table", DIALOG:"dialog", H1:"heading", H2:"heading", H3:"heading" }[e.tagName]) || (e.type === "checkbox" || e.type === "radio" ? e.type : "textbox");
  const candidates = () => [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,[role],table,h1,h2,h3,dialog')].filter(visible);
  const signature = e => JSON.stringify([e.tagName, role(e), label(e), e.id, e.getAttribute("name"), e.type, e.getAttribute("href"), e.getAttribute("formaction"), e.form?.action, e.form?.method]);
  const refFor = e => {
    for (const [ref, old] of state.refs) if (old.element === e && old.signature === signature(e)) return ref;
    const ref = `${performance.timeOrigin.toString(36)}-${state.next++}`;
    if (state.refs.size >= 3000) state.refs.delete(state.refs.keys().next().value);
    state.refs.set(ref, {element:e, signature:signature(e)}); return ref;
  };
  const find = ref => {
    const old = state.refs.get(ref); if (!old) throw Error("stale_reference_refresh_page");
    if (old.element.isConnected && visible(old.element) && signature(old.element) === old.signature) return old.element;
    const matches = candidates().filter(e => signature(e) === old.signature);
    if (matches.length !== 1) throw Error("stale_or_ambiguous_reference_refresh_page");
    old.element = matches[0]; return matches[0];
  };
  const safeText = root => {
    // Prune hidden subtrees before collecting text; cloning would lose CSS visibility.
    const excluded = 'script,style,noscript,input,textarea,[hidden],[aria-hidden="true"],[data-private],[inert]';
    let text = "", visits = 0;
    const walk = node => {
      if (++visits > 50000 || text.length >= 24000) return;
      if (node.nodeType === 3) { text += " " + node.textContent.slice(0, 24000 - text.length); return; }
      if (node.nodeType !== 1 || node.matches(excluded)) return;
      const css = getComputedStyle(node);
      if (css.display === "none" || css.visibility !== "visible" || css.contentVisibility === "hidden") return;
      for (const child of node.childNodes) walk(child);
    };
    if (root) walk(root);
    return clean(text, 24000);
  };
  const guard = e => { if (sensitive(e) || e.closest('[data-private]')) throw Error("human_confirmation_required"); if (!visible(e) || e.disabled) throw Error("element_not_actionable"); };
  if (op === "interference") {
    if (!state.listening) {
      state.listening = true;
      for (const name of ["pointerdown", "keydown", "wheel"]) document.addEventListener(name, event => {
        if (event.isTrusted) chrome.runtime.sendMessage({type:"interaction"}).catch(() => {});
      }, {capture:true,passive:true});
    }
    return {ok:true};
  }
  if (op === "read") {
    const query = clean(args.query, 200).toLowerCase();
    const all = candidates().filter(e => !sensitive(e) && !e.closest('[data-private]'));
    const elements = all.filter(e => !query || label(e).toLowerCase().includes(query)).slice(0, 180).map(e => ({ref:refFor(e),role:role(e),name:label(e),tag:e.tagName.toLowerCase(),type:e.type,checked:typeof e.checked === "boolean" ? e.checked : undefined,disabled:!!e.disabled,options:e.tagName === "SELECT" ? [...e.options].slice(0,100).map(o=>({label:clean(o.label),value:clean(o.value)})) : undefined}));
    const tables = [...document.querySelectorAll("table")].filter(visible).slice(0,10).map(t => {
      let rows = [...t.rows]; if (query) rows = rows.filter(r => safeText(r).toLowerCase().includes(query));
      const offset = Math.max(0, Number(args.offset) || 0), limit = Math.min(200, Math.max(1, Number(args.limit) || 100));
      return {ref:refFor(t),totalRows:rows.length,offset,rows:rows.slice(offset,offset+limit).map(r=>[...r.cells].slice(0,40).map(c=>safeText(c).slice(0,500)))};
    });
    const result = {ok:true,trust:"untrusted_page_data",url:location.origin+location.pathname,title:clean(document.title),text:safeText(document.body),elements:[],tables:[],elementCount:all.length,truncated:all.length>180};
    // Budget the whole result, including JSON escaping and option labels, below the link cap.
    let budget = 54000 - JSON.stringify(result).length;
    for (const element of elements) { const size = JSON.stringify(element).length + 1; if (size > budget) { result.truncated = true; break; } result.elements.push(element); budget -= size; }
    for (const table of tables) {
      const bounded = {...table, rows:[]}; let size = JSON.stringify(bounded).length + 1;
      if (size > budget) { result.truncated = true; break; } budget -= size;
      for (const row of table.rows) { size = JSON.stringify(row).length + 1; if (size > budget) { result.truncated = true; break; } bounded.rows.push(row); budget -= size; }
      result.tables.push(bounded);
    }
    return result;
  }
  const e = args.ref ? find(args.ref) : null;
  if (e) guard(e);
  const describe = () => {
    const form = e?.form || e?.closest("form");
    const fields = form ? [...form.elements].filter(x=>!sensitive(x) && !x.closest('[data-private]')).slice(0,60).map(x=>({name:label(x),value:x.type==="file"?[...x.files].map(f=>f.name):String(x.value || "").slice(0,1000),checked:x.checked})) : [];
    const context = safeText(form || e?.parentElement || document.body).slice(0,1800);
    return {ok:true,binding:JSON.stringify([location.href,performance.timeOrigin,e?signature(e):null,fields,context]),description:{site:location.origin+location.pathname,title:clean(document.title),target:e?{role:role(e),name:label(e)}:null,destination:e?.href || e?.formAction || form?.action || null,fields,context}};
  };
  if (op === "describe") return describe();
  if (args.expectedBinding && describe().binding !== args.expectedBinding) throw Error("page_changed_after_approval");
  if (op === "fileTarget") { if (!e?.matches('input[type="file"]')) throw Error("not_file_input"); const marker = crypto.randomUUID(); e.setAttribute("data-loopcom-upload",marker); return {ok:true,selector:`[data-loopcom-upload="${marker}"]`}; }
  if (op === "downloadTarget") { if (!e?.matches('a[href]')) throw Error("download_requires_link"); const u = new URL(e.href); if (!["https:","http:"].includes(u.protocol) || u.username || u.password) throw Error("unsafe_download_url"); return {ok:true,url:u.href}; }
  if (op === "wait") return {ok:true,found:safeText(document.body).includes(String(args.text || ""))};
  if (op !== "act") throw Error("unknown_page_operation");
  if (args.action === "scroll") { window.scrollBy({left:Number(args.x)||0,top:Number(args.y)||0,behavior:"instant"}); return {ok:true,scrollY}; }
  if (!e) throw Error("element_ref_required");
  if (args.action === "click") e.click();
  else if (args.action === "fill") {
    if (!e.matches('input:not([type="file"]),textarea')) throw Error("not_text_input");
    const proto = e.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto,"value").set.call(e,String(args.value || ""));
    e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true}));
    if (e.value !== String(args.value || "")) throw Error("value_verification_failed");
  } else if (args.action === "select") {
    if (e.tagName !== "SELECT") throw Error("not_select"); const match = [...e.options].filter(o=>o.value === args.value || o.label === args.value);
    if (match.length !== 1) throw Error("option_not_unique"); e.value = match[0].value; e.dispatchEvent(new Event("change",{bubbles:true}));
  } else if (args.action === "check") { if (!["checkbox","radio"].includes(e.type)) throw Error("not_checkable"); const checked = args.checked !== false; if (e.checked !== checked) e.click(); if (e.checked !== checked) throw Error("check_verification_failed");
  } else if (args.action === "submit") { const f = e.form || e.closest("form"); if (!f) throw Error("not_form"); f.requestSubmit();
  } else if (args.action === "hover") { e.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));
  } else if (args.action === "focus") { e.focus({preventScroll:true});
  } else throw Error("unknown_action");
  return {ok:true,action:args.action,verification:"Read the resulting page; a dispatched action alone is not task completion."};
}
