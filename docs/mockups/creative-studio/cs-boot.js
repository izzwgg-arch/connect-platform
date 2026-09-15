/* Loopcom Creative Studio mockup — navigation, theme, mode, Coworker bubble. */
(function () {
  const { $, $$, ic, esc } = CS;
  const NAV = {
    user: [
      { label: "Workspace", items: ["coworker"] },
      { label: "Creative Studio", sub: "new section", items: ["home", "projects", "assets", "brand", "memory"] },
      { label: "Create", items: ["image", "video", "design", "timeline"] },
      { label: "Inside a project", items: ["concept", "storyboard", "agentdesign", "audio", "versions", "export", "render", "result"] },
      { label: "Other layouts", items: ["mobile", "states"] },
    ],
    admin: [
      { label: "Admin · Creative Studio", sub: "platform staff", items: ["adash", "amodels", "aworkers", "aqueue", "ausage", "alimits", "aaudit"] },
    ],
    review: [
      { label: "Design review", items: ["rA", "rB", "rC", "rD", "rE", "rF", "rG", "rH", "rI", "rJ"] },
    ],
  };
  const DEFAULT = { user: "home", admin: "adash", review: "rA" };

  function buildNav() {
    const mode = CS.state.mode;
    $("#sbNav").innerHTML = NAV[mode].map((g) => `<div class="sb-label">${g.label}${g.sub ? ` <span class="sb-sub">· ${g.sub}</span>` : ""}</div>` +
      g.items.map((id) => { const s = CS.screens[id]; if (!s) return ""; return `<button class="sb-link" type="button" data-go="${id}"><span class="sb-ico">${ic(s.icon || "spark")}</span><span>${s.nav || s.title}</span>${s.badge ? `<span class="sb-badge ${s.badgeCls || ""}">${s.badge}</span>` : "<span></span>"}</button>`; }).join("")).join("");
    const p = mode === "admin" ? ["IW", "Izzy W.", "Loopcom · Platform owner"] : mode === "review" ? ["IW", "Izzy W.", "Reviewing Phase 0"] : ["JL", "Jacob L.", "Loopcom Demo · Account owner"];
    $("#sbAvatar").textContent = p[0]; $("#sbTenant").innerHTML = `<b>${p[1]}</b>${p[2]}`;
    $("#tbQuota").hidden = mode !== "user";
  }
  function modeOf(id) { for (const m of Object.keys(NAV)) if (NAV[m].some((g) => g.items.includes(id))) return m; return "user"; }

  CS.go = (id, { push = true } = {}) => {
    const s = CS.screens[id] || CS.screens[DEFAULT[CS.state.mode]];
    CS.clearTimers();
    const m = modeOf(s.id);
    if (m !== CS.state.mode) { CS.state.mode = m; $$("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === m)); buildNav(); }
    $$(".sb-link").forEach((b) => b.toggleAttribute("aria-current", false));
    const cur = $(`.sb-link[data-go="${s.id}"]`); if (cur) cur.setAttribute("aria-current", "page");
    const view = $("#view");
    const head = s.bare ? "" : `<div class="ribbon"><span class="crumb">${(s.crumb || []).map(esc).join(` ${ic("chev", "sm")} `)}</span></div>
      <div class="pagehead"><div><h2>${s.title}</h2>${s.desc ? `<p>${s.desc}</p>` : ""}</div>${s.actions ? `<div class="head-actions">${s.actions}</div>` : ""}</div>`;
    view.innerHTML = head + s.render();
    CS.hydrate(view); CS.wireSwitches(view); CS.wireChips(view);
    $$("[data-go]", view).forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); CS.go(b.dataset.go); }));
    s.init && s.init(view);
    if (push) history.replaceState(null, "", "#/" + s.id);
    window.scrollTo(0, 0); document.body.classList.remove("nav-open");
    $("#bubble").hidden = s.id === "coworker" || CS.state.mode !== "user";
    $("#pop").hidden = true;
  };

  $("#sbNav").addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) CS.go(b.dataset.go); });
  $$("[data-mode]").forEach((b) => b.addEventListener("click", () => { CS.state.mode = b.dataset.mode; $$("[data-mode]").forEach((x) => x.setAttribute("aria-pressed", x === b)); buildNav(); CS.go(DEFAULT[b.dataset.mode]); }));
  function setTheme(t) { document.documentElement.dataset.theme = t; $$("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.themeSet === t)); setTimeout(() => $$("canvas.art").forEach((cv) => CS.paint(cv, 0)), 30); }
  $$("[data-theme-set]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.themeSet)));
  $("#navToggle").addEventListener("click", () => document.body.classList.toggle("nav-open"));

  /* bubble: the Coworker is reachable from every Creative Studio page and sees the page you are on */
  $("#bubble").addEventListener("click", () => {
    const pop = $("#pop"); const s = CS.screens[(location.hash.slice(2) || "home")] || {};
    if (!pop.hidden) { pop.hidden = true; return; }
    pop.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border)"><span class="avatar cw">${ic("loop", "sm")}</span><div style="flex:1"><b style="font-size:14px">Coworker</b><div class="faint" style="font-size:12px">Sees: ${esc(s.title || "Creative Studio")}</div></div><button class="iconbtn" type="button" data-go-cw aria-label="Open full page">${ic("maximize")}</button><button class="iconbtn" type="button" id="popClose" aria-label="Minimize">${ic("x")}</button></div>
      <div style="padding:14px;display:grid;gap:10px"><p style="font-size:13.5px"><b>What should we make?</b> <span class="muted">I can make images, videos and designs using your Loopcom Demo brand kit, and change anything on this page for you.</span></p>
      <div class="stack" style="gap:6px">
        <button class="chip" type="button" data-go-cw style="justify-content:flex-start;border-radius:10px;padding:8px 10px">${ic("video", "sm")}Make me a professional 15-second commercial for Loopcom about AI technical support</button>
        <button class="chip" type="button" data-go="agentdesign" style="justify-content:flex-start;border-radius:10px;padding:8px 10px">${ic("layout", "sm")}Make this flyer look more expensive</button>
        <button class="chip" type="button" data-go="image" style="justify-content:flex-start;border-radius:10px;padding:8px 10px">${ic("image", "sm")}Remove the background from our desk phone photo</button>
      </div>
      <div class="input" style="display:flex;align-items:center;color:var(--text-faint)">Tell Coworker what to make…<span style="margin-left:auto" class="btn primary sm">${ic("send", "sm")}</span></div></div>`;
    pop.hidden = false;
    $("#popClose").onclick = () => (pop.hidden = true);
    $$("[data-go-cw]", pop).forEach((b) => (b.onclick = () => CS.go("coworker")));
    $$("[data-go]", pop).forEach((b) => (b.onclick = () => CS.go(b.dataset.go)));
  });

  addEventListener("hashchange", () => { const id = location.hash.slice(2); if (CS.screens[id]) CS.go(id, { push: false }); });
  buildNav();
  const start = location.hash.slice(2);
  CS.go(CS.screens[start] ? start : "home", { push: !!CS.screens[start] });
})();
