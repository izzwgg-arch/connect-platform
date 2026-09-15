/* Customer-facing Creative Studio screens. Example data only. */
(function () {
  const { ic, esc, art, $, $$ } = CS;
  const R = (id, d) => CS.register(id, d);

  /* =============== 1. STUDIO HOME =============== */
  const KINDS = [
    ["Image", "image", "Photos, product shots, illustrations", "image"],
    ["AI video", "video", "Up to 15 seconds per shot", "video"],
    ["Social graphic", "layout", "Instagram, Facebook, WhatsApp", "design"],
    ["Advertisement", "megaphone", "Paid social and display", "design"],
    ["Flyer", "file", "Print and PDF", "design"],
    ["Poster", "template", "Large format", "design"],
    ["Presentation graphic", "chart", "Slides and diagrams", "design"],
    ["Product creative", "tag", "Desk phones, hardware, packs", "image"],
    ["Logo / branding", "spark", "Marks, lockups, variations", "image"],
    ["Custom canvas", "crop", "Any size you like", "design"],
  ];
  R("home", {
    icon: "home", nav: "Studio home", title: "Creative Studio",
    crumb: ["Loopcom Demo", "Creative Studio"],
    desc: "Make images, videos, graphics and ads with your own brand. Ask the Coworker, or open the editor yourself — both work on the same project.",
    actions: `<button class="btn" type="button" data-state-demo>${ic("eye", "sm")}Show first-time view</button><button class="btn primary" type="button" data-go="coworker">${ic("loop", "sm")}Ask the Coworker</button>`,
    render() {
      return `<div id="homeReal">
      <div class="card" style="margin-bottom:14px">
        <div class="card-h"><h3>Start something</h3><span class="sub">Every one of these can also be asked for in plain English</span><span class="end"><span class="pill info nub">${ic("brain", "sm")}Uses your brand kit + what it has learned</span></span></div>
        <div class="tiles">${KINDS.map(([n, i, s, go]) => `<button class="tile" type="button" data-go="${go}"><span class="ti ${i === "video" ? "v" : ""}">${ic(i, "lg")}</span><b>${n}</b><span>${s}</span></button>`).join("")}</div>
      </div>
      <div class="grid g2" style="margin-bottom:14px">
        <div class="card"><div class="card-h"><h3>Pick up where you left off</h3><span class="end"><button class="btn sm ghost" type="button" data-go="projects">All projects${ic("chev", "sm")}</button></span></div>
          <div class="rowscroll">
            ${[["AI support commercial", "15s video · 3 shots", "office", 3, "In review"], ["Spring desk-phone promo", "Flyer + 4 social sizes", "product", 7, "Draft"], ["Careers post", "1080×1350", "team", 11, "Exported"], ["Yiddish support explainer", "30s video · 5 shots", "support", 5, "Rendering"]].map(([t, m, sc, sd, st]) => `
            <button class="projcard" type="button" data-go="project"><div class="thumb">${art(sc, sd)}<span class="badge">${ic(sc === "product" || sc === "team" ? "image" : "video", "sm")}${sc === "product" || sc === "team" ? "Design" : "Video"}</span></div><div class="pb"><b>${t}</b><div class="pm">${esc(m)} <span class="pill ${st === "Rendering" ? "warn" : st === "Exported" ? "ok" : ""}" style="margin-left:auto">${st}</span></div></div></button>`).join("")}
          </div></div>
        <div class="card"><div class="card-h"><h3>Recent generations</h3><span class="sub">Everything the studio made, newest first</span></div>
          <div class="rowscroll">${[["office", 3, "15s · Production"], ["support", 5, "8s · Draft"], ["product", 7, "Image · 4 of 4"], ["loop", 2, "5s · End card"], ["city", 9, "Image"], ["phone", 4, "Image"]].map(([sc, sd, m]) => `
            <div class="gen"><div class="thumb">${art(sc, sd)}<span class="dur">${m.startsWith("Image") ? "PNG" : m.split(" ")[0]}</span></div><div class="meta">${ic("clock", "sm")}${esc(m)}</div></div>`).join("")}</div></div>
      </div>
      <div class="grid g4">
        <div class="card"><div class="card-h"><h3>Templates</h3></div><div class="stack" style="gap:8px">${["Loopcom 15s ad — cinematic", "Desk-phone promo flyer", "Instagram carousel — 4 up", "Job post — dark"].map((t) => `<button class="chip" type="button" style="justify-content:flex-start">${ic("template", "sm")}${t}</button>`).join("")}</div></div>
        <div class="card"><div class="card-h"><h3>Brand kits</h3><span class="end"><button class="btn sm ghost" type="button" data-go="brand">Open</button></span></div>
          <div class="stack" style="gap:8px"><button class="chip on" type="button" style="justify-content:flex-start">${ic("palette", "sm")}Loopcom — Signal Core</button><button class="chip" type="button" style="justify-content:flex-start">${ic("palette", "sm")}Loopcom Demo — internal</button><p class="help">Only this company can see these.</p></div></div>
        <div class="card"><div class="card-h"><h3>Favourites</h3></div><div class="stack" style="gap:8px">${[["loop", 2, "Logo end card"], ["office", 3, "Dusk office still"]].map(([sc, sd, t]) => `<div class="row"><div class="thumb" style="width:64px;flex:none">${art(sc, sd)}</div><div><b style="font-size:12.5px">${t}</b><div class="help">${ic("star", "sm")} kept for reuse</div></div></div>`).join("")}</div></div>
        <div class="card"><div class="card-h"><h3>Drafts</h3><span class="end"><span class="pill warn">2</span></span></div><div class="stack" style="gap:6px"><div class="row"><span class="faint">${ic("file", "sm")}</span><div style="flex:1"><b style="font-size:12.5px">Untitled poster</b><div class="help">Edited 2 days ago</div></div></div><div class="row"><span class="faint">${ic("file", "sm")}</span><div style="flex:1"><b style="font-size:12.5px">Untitled 9:16 video</b><div class="help">Edited 6 days ago</div></div></div><p class="help">Drafts are deleted after 30 days.</p></div></div>
      </div></div>

      <div id="homeFirst" hidden>
        <div class="empty"><span class="ti" style="width:54px;height:54px;border-radius:16px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center">${ic("spark", "xl")}</span>
          <h3>Let's set up your look first</h3>
          <p>Creative Studio makes everything with your company's own logo, colours and fonts. Add them once and every image, video and design starts out on-brand.</p>
          <div class="row wrap" style="justify-content:center"><button class="btn primary" type="button" data-go="brand">${ic("palette", "sm")}Set up the brand kit</button><button class="btn" type="button" data-go="coworker">${ic("loop", "sm")}Skip — just make something</button></div>
          <div class="row wrap" style="justify-content:center;margin-top:8px">${["1. Brand kit", "2. First project", "3. Ask the Coworker"].map((s, i) => `<span class="pill ${i === 0 ? "info" : ""}">${s}</span>`).join("")}</div>
        </div>
        <div class="grid g3" style="margin-top:14px">${[["Upload your logo", "PNG or SVG. We keep a light and a dark version.", "upload"], ["Pick your colours", "We read them off your logo and you correct them.", "palette"], ["Choose your fonts", "Headline and body. Used everywhere after that.", "type"]].map(([t, d, i]) => `<div class="card"><div class="row" style="align-items:flex-start"><span class="ti" style="width:32px;height:32px;border-radius:9px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center">${ic(i)}</span><div><b>${t}</b><p class="muted" style="font-size:12.5px;margin-top:3px">${d}</p></div></div></div>`).join("")}</div>
      </div>`;
    },
    init(root) {
      let first = false;
      $("[data-state-demo]", root).onclick = (e) => {
        first = !first; $("#homeReal").hidden = first; $("#homeFirst").hidden = !first;
        e.currentTarget.innerHTML = ic("eye", "sm") + (first ? "Show normal view" : "Show first-time view");
      };
    },
  });

  /* =============== 2. COWORKER CHAT =============== */
  const PLAN = ["Understand the ask", "Propose a concept", "Build the storyboard", "Render the shots", "Add voice, music and captions", "Show you the cut", "Make your changes", "Export"];
  R("coworker", {
    icon: "loop", nav: "Coworker", badge: "chat", badgeCls: "new", title: "Coworker",
    crumb: ["Workspace", "Coworker"],
    desc: "The same Coworker you already have. Ask it for a commercial and it plans, renders, edits and delivers — showing every step in plain English.",
    actions: `<button class="btn" type="button" id="cwReplay">${ic("refresh", "sm")}Replay from the start</button>`,
    render() {
      return `<div class="cwapp">
        <div class="cwchat">
          <div class="head"><span class="avatar cw">${ic("loop", "sm")}</span><div style="flex:1"><b>AI support commercial</b><div class="faint" style="font-size:12px" id="cwStatus">Working…</div></div>
            <span class="pill info nub">${ic("dollar", "sm")} <span id="cwCost">0.00</span> spent</span>
            <button class="iconbtn" type="button" aria-label="New task">${ic("plus")}</button></div>
          <div class="msgs" id="cwMsgs" aria-live="polite"></div>
          <div class="comp"><div class="cwbox"><textarea rows="2" id="cwInput" placeholder="Tell Coworker what to make…"></textarea>
            <div class="cwbar"><button class="iconbtn" type="button" aria-label="Attach">${ic("upload")}</button>
              <span class="chip nub" style="pointer-events:none">${ic("shield", "sm")}Asks before spending</span>
              <span class="chip nub" style="pointer-events:none">${ic("palette", "sm")}Loopcom brand kit</span>
              <button class="btn primary sm" type="button" id="cwSend" style="margin-left:auto">${ic("send", "sm")}Send</button></div></div>
            <p class="help" style="text-align:center;margin-top:7px">Coworker can make mistakes. Nothing is sent, published or paid for without your OK.</p></div>
        </div>
        <aside class="insp">
          <div><h4>What it's doing</h4><ul class="plan" id="cwPlan">${PLAN.map((p, i) => `<li class="${i === 0 ? "now" : ""}"><span class="pd"></span>${p}</li>`).join("")}</ul></div>
          <div><h4>Right now</h4><div style="border:1px solid var(--border);border-radius:10px;overflow:hidden"><div class="thumb" id="cwLive">${art("loop", 2, 'data-anim="1"')}</div><div style="padding:7px 9px;font-size:11.5px" class="muted" id="cwLiveLabel">Reading your brand kit</div></div></div>
          <div><h4>This task</h4><dl class="kv"><dt>Shots</dt><dd id="kShots">0 of 3</dd><dt>Video seconds</dt><dd id="kSecs">0</dd><dt>Re-renders</dt><dd id="kRetry">0</dd><dt>Spent</dt><dd id="kSpend">$0.00</dd></dl></div>
          <div><h4>Made so far</h4><div class="stack" id="cwMade" style="gap:6px"><span class="help">Nothing yet.</span></div></div>
          <button class="btn danger" type="button" style="justify-content:center">${ic("stop", "sm")}Stop everything</button>
        </aside></div>`;
    },
    init(root) { flow(root); $("#cwReplay", root).onclick = () => CS.go("coworker"); },
  });

  function flow(root) {
    const msgs = $("#cwMsgs", root), runId = CS.runId || 0;
    const alive = () => (CS.runId || 0) === runId && msgs.isConnected;
    let cost = 0, secs = 0, shots = 0, retry = 0;
    const setPlan = (i) => $$("#cwPlan li", root).forEach((li, k) => { li.className = k < i ? "done" : k === i ? "now" : ""; });
    const live = (scene, seed, label) => { $("#cwLive", root).innerHTML = art(scene, seed, 'data-anim="1"'); $("#cwLiveLabel", root).textContent = label; CS.hydrate($("#cwLive", root)); };
    const spend = (n) => { cost += n; $("#cwCost", root).textContent = cost.toFixed(2); $("#kSpend", root).textContent = CS.money(cost); };
    const made = (label, icon) => { const box = $("#cwMade", root); if (box.querySelector(".help")) box.innerHTML = ""; box.insertAdjacentHTML("beforeend", `<span class="chip nub" style="justify-content:flex-start">${ic(icon, "sm")}${esc(label)}</span>`); };
    const el = (html) => { const d = document.createElement("div"); d.innerHTML = html; const n = d.firstElementChild; msgs.appendChild(n); CS.hydrate(n); msgs.scrollTop = msgs.scrollHeight; return n; };
    const user = (t) => el(`<div class="msg-user">${esc(t)}</div>`);
    const ai = (inner) => el(`<div class="msg-ai"><span class="avatar cw">${ic("loop", "sm")}</span><div class="body">${inner}</div></div>`);
    const wait = (ms) => new Promise((r) => CS.later(r, ms));
    const pick = (node, sel) => new Promise((res) => $$(sel, node).forEach((b) => (b.onclick = () => { $$(sel, node).forEach((x) => x.classList.remove("on")); b.classList.add("on"); res(b); })));

    (async function run() {
      user("Make me a professional 15-second commercial for Loopcom about AI technical support.");
      await wait(500); if (!alive()) return;
      const m1 = ai(`<div class="typing"><i></i><i></i><i></i></div>`);
      await wait(900); if (!alive()) return;
      m1.querySelector(".body").innerHTML = CS.steps("Getting ready", [
        { tool: "Thinking", icon: "spark", label: "Working out what the ad has to say", state: "2s" },
        { tool: "Brand kit", icon: "palette", label: "Reading your Loopcom brand kit", state: "1s", media: true },
        { tool: "Memory", icon: "brain", label: "Checking what you've liked before", state: "1s", media: true },
      ], false, "4s") + `<div class="text"><p>Here's what I'm working from: your Signal Core logo, <b>#22A8FF → #4F7BFF on near-black</b>, Inter, and the three things you've told me before — <b>cinematic, real people, no flashy typography</b>. Three ideas, all 15 seconds:</p></div>`;
      live("loop", 2, "Reading your brand kit");
      await wait(700); if (!alive()) return;
      setPlan(1);
      const cNode = ai(`<div class="concepts">
        ${[["The 2am shift", "office", 3, "A shop floor at night, one phone rings, the Coworker answers it. Warm, quiet, cinematic.", "Cinematic · voiceover"],
          ["Ask it anything", "phone", 4, "Close on a phone: someone types a messy question, an answer comes straight back.", "Phone-first · captions"],
          ["One number, one answer", "support", 5, "Support panels assembling around a person with a headset. Techy and bright.", "Graphic · music only"]]
          .map(([t, sc, sd, d, tag], i) => `<button class="concept ${i === 0 ? "on" : ""}" type="button"><div class="thumb">${art(sc, sd)}</div><div class="cb"><b>${t}</b><p>${d}</p><span class="pill info nub">${tag}</span></div></button>`).join("")}
      </div><div class="text"><p class="muted" style="font-size:12.5px">Pick one and I'll storyboard it. All three cost about the same: <b>$2.40</b> and roughly 4 minutes.</p></div>`);
      const chosen = await pick(cNode, ".concept"); if (!alive()) return;
      user("The first one — the 2am shift.");
      await wait(600); if (!alive()) return; setPlan(2); live("office", 3, "Building the storyboard");
      ai(CS.steps("Storyboard", [{ tool: "Storyboard", icon: "film", label: "Splitting 15 seconds into 3 shots", state: "2s", media: true }], false, "2s") +
        `<div class="text"><p>Three shots, 5 seconds each. The end card uses your logo as-is — I never redraw it.</p></div>
        <div class="stack" style="gap:8px">${[["1", "Empty shop floor at night. One desk phone lights up and rings.", "office", 3], ["2", "The Coworker answers: calm panels, a real person taking the call.", "support", 5], ["3", "Logo end card: Loopcom mark, one line of type, blue glow.", "loop", 2]].map(([n, d, sc, sd]) => `
          <div class="row" style="align-items:flex-start"><div class="thumb" style="width:120px;flex:none">${art(sc, sd)}<span class="dur">5s</span></div><div><b style="font-size:13px">Shot ${n}</b><p class="muted" style="font-size:12.5px">${d}</p></div></div>`).join("")}</div>
        <div class="row wrap"><button class="btn sm" type="button" data-go="storyboard">${ic("film", "sm")}Open the storyboard</button><span class="help">You can change any shot before we render.</span></div>`);
      await wait(900); if (!alive()) return; setPlan(3);
      const apNode = ai(`<div class="approve"><div class="approve-h">${ic("alert", "sm")}Coworker needs your OK</div>
        <p style="font-size:13.5px">Render <b>3 production shots</b> — 15 seconds of video at 1080p.</p>
        <div class="kv" style="font-size:12.5px"><dt>Engine</dt><dd>Loopcom video · production</dd><dt>Estimate</dt><dd>$2.40</dd><dt>Time</dt><dd>about 4 minutes</dd><dt>This month so far</dt><dd>41 of 120 seconds</dd></div>
        <div class="row wrap"><button class="btn primary sm" data-a="yes" type="button">Render it</button><button class="btn sm" data-a="draft" type="button">Draft first ($0.30)</button><button class="btn sm" data-a="no" type="button">Not now</button></div></div>`);
      const ans = await pick(apNode, "[data-a]"); if (!alive()) return;
      const draft = ans.dataset.a === "draft";
      if (ans.dataset.a === "no") { ai(`<div class="text"><p>No problem — nothing was rendered and nothing was charged. The storyboard is saved if you want to come back to it.</p></div>`); $("#cwStatus", root).textContent = "Waiting for you"; return; }
      apNode.querySelector(".body").innerHTML = `<div class="muted" style="font-size:12.5px;display:flex;gap:6px;align-items:center"><span class="ok-ic">${ic("check", "sm")}</span>You said ${draft ? "draft first" : "yes"} · 2:41 PM</div>`;

      const stepsBox = ai(`<div id="renderSteps"></div>`);
      const renderList = [
        { tool: "Video", icon: "video", label: "Shot 1 — night shop floor", state: "queued", st: "todo", media: true },
        { tool: "Video", icon: "video", label: "Shot 2 — the Coworker answers", state: "queued", st: "todo", media: true },
        { tool: "Video", icon: "video", label: "Shot 3 — logo end card", state: "queued", st: "todo", media: true },
      ];
      const paint = (working, time) => { $("#renderSteps", root).innerHTML = CS.steps(draft ? "Rendering drafts" : "Rendering 15 seconds", renderList, working, time); msgs.scrollTop = msgs.scrollHeight; };
      paint(true, "0:02");
      const scenes = [["office", 3], ["support", 5], ["loop", 2]];
      for (let i = 0; i < 3; i++) {
        renderList[i].st = "run"; live(scenes[i][0], scenes[i][1], `Rendering shot ${i + 1} of 3`);
        for (let p = 10; p <= 100; p += 30) { renderList[i].state = p + "%"; paint(true, "0:" + String(10 + i * 18 + p / 10).padStart(2, "0")); await wait(320); if (!alive()) return; }
        if (i === 1) {
          renderList[i].st = "fail"; renderList[i].state = "re-doing"; paint(true, "0:46");
          renderList.splice(2, 0, { tool: "Check", icon: "eye", label: "Checked shot 2 — the hand came out wrong, so I re-rendered it once", state: "caught it", st: "wait", media: true });
          retry++; $("#kRetry", root).textContent = retry; spend(draft ? 0.1 : 0.8);
          await wait(900); if (!alive()) return;
          renderList[1].st = "done"; renderList[1].state = draft ? "8s draft" : "5s · take 2"; paint(true, "1:10");
        } else { renderList[i].st = "done"; renderList[i].state = draft ? "8s draft" : "5s"; }
        shots++; secs += draft ? 8 : 5; spend(draft ? 0.1 : 0.8);
        $("#kShots", root).textContent = `${shots} of 3`; $("#kSecs", root).textContent = secs;
        made(`Shot ${i + 1}`, "video"); paint(i < 2, i < 2 ? "1:20" : "3:41");
      }
      setPlan(4); if (!alive()) return;
      ai(CS.steps("Sound and captions", [
        { tool: "Voice", icon: "mic", label: "Voiceover in Rachel — 19 words, matched to the cut", state: "3s", media: true },
        { tool: "Music", icon: "music", label: "Music bed — slow build, ducked under the voice", state: "4s", media: true },
        { tool: "Captions", icon: "cc", label: "Captions from the voiceover, your caption style", state: "2s", media: true },
        { tool: "Render", icon: "film", label: "Joining the shots, transitions, end card", state: "22s", media: true },
      ], false, "0:31"));
      spend(0.09); made("Voiceover", "mic"); made("Music bed", "music");
      await wait(700); if (!alive()) return; setPlan(5); live("support", 5, "Playing the cut");
      ai(`<div class="text"><p>Here's the cut. ${draft ? "These are drafts — grainier and 8 seconds each — so you can judge the idea before we spend on production." : "15 seconds, 1080p, captions burned in."}</p></div>
        ${CS.player("office", 3, { dur: draft ? "0:24" : "0:15", cap: 'Your phones never sleep. <em>Neither do we.</em>' })}
        <div class="row wrap"><span class="pill ok">${draft ? "Draft" : "Production"} · ${draft ? "24s" : "15s"}</span><span class="pill nub">${ic("dollar", "sm")}${CS.money(cost)} so far</span><button class="btn sm" type="button" data-go="timeline">${ic("film", "sm")}Open in the editor</button><button class="btn sm" type="button" data-go="storyboard">${ic("grid", "sm")}Storyboard</button></div>`);
      await wait(400); if (!alive()) return;
      const revNode = ai(`<div class="text"><p class="muted" style="font-size:12.5px">Want anything changed? Try one of these, or type your own.</p></div>
        <div class="stack" style="gap:6px"><button class="chip" type="button" data-r="logo" style="justify-content:flex-start">Make the logo smaller at the end and hold it a beat longer</button>
        <button class="chip" type="button" data-r="pace" style="justify-content:flex-start">Shot 2 is too fast — slow it down</button>
        <button class="chip" type="button" data-r="ok" style="justify-content:flex-start">It's good — export it</button></div>`);
      const rev = await pick(revNode, "[data-r]"); if (!alive()) return;
      setPlan(6);
      if (rev.dataset.r !== "ok") {
        user(rev.textContent.trim());
        await wait(600); if (!alive()) return;
        const isLogo = rev.dataset.r === "logo";
        ai(CS.steps("Your changes", isLogo ? [
          { tool: "Canvas", icon: "layout", label: "End card: logo 34% → 24%, moved up 40px", state: "instant", media: true },
          { tool: "Timeline", icon: "film", label: "End card held 1.2s longer, music tail extended", state: "1s", media: true },
          { tool: "Render", icon: "film", label: "Re-rendered the last 4 seconds only", state: "14s", media: true },
        ] : [
          { tool: "Timeline", icon: "film", label: "Shot 2 slowed to 80% and re-timed to the voiceover", state: "1s", media: true },
          { tool: "Video", icon: "video", label: "Re-generated shot 2 with slower camera movement", state: "48s", media: true },
          { tool: "Check", icon: "eye", label: "Compared it against take 1 — this one is cleaner", state: "done", media: true },
        ], false, isLogo ? "0:15" : "0:52") +
          `<div class="text"><p>${isLogo ? "Done — the mark is smaller and holds for 1.2 seconds longer. I only re-rendered the end card, so this cost <b>$0.20</b>." : "Done — shot 2 is slower and lands on the voice. Re-rendering one shot cost <b>$0.80</b>."} I've written this down as something you prefer.</p></div>
          <div class="row wrap"><span class="pill info">${ic("brain", "sm")}Learned: ${isLogo ? "logo should not dominate the end card" : "prefers slower camera moves"}</span><button class="btn sm ghost" type="button" data-go="memory">See what it learned</button></div>`);
        spend(isLogo ? 0.2 : 0.8);
        await wait(500); if (!alive()) return;
      }
      setPlan(7); user("Export it for WhatsApp Status and YouTube.");
      await wait(600); if (!alive()) return;
      ai(CS.steps("Export", [
        { tool: "Export", icon: "download", label: "WhatsApp Status — 1080×1920, safe areas checked", state: "12s", media: true },
        { tool: "Export", icon: "download", label: "YouTube — 1920×1080, H.264, loudness −14 LUFS", state: "16s", media: true },
      ], false, "0:28") +
        `<div class="text"><p>Both are ready. The 9:16 version re-framed to keep the person and the logo inside the safe area — have a look before you post it.</p></div>
        <div class="row wrap">${[["WhatsApp Status", "9:16 · 14.2 MB"], ["YouTube", "16:9 · 21.8 MB"], ["Captions .srt", "2 KB"]].map(([t, m]) => `<span class="chip nub">${ic("download", "sm")}<b>${t}</b> <span class="faint">${m}</span></span>`).join("")}</div>
        <div class="row wrap"><button class="btn primary sm" type="button" data-go="result">${ic("play", "sm")}Open the finished ad</button><button class="btn sm" type="button" data-go="export">${ic("sliders", "sm")}Export settings</button></div>`);
      made("Final cut", "film"); made("2 exports", "download");
      setPlan(8); $("#cwStatus", root).textContent = "Done · 4 min 39s"; live("loop", 2, "Finished");
      $$("#cwPlan li", root).forEach((li) => (li.className = "done"));
    })();
  }

  /* =============== 3. CONCEPT SELECTION =============== */
  R("concept", {
    icon: "spark", nav: "Concept", title: "Choose a concept",
    crumb: ["Creative Studio", "AI support commercial", "Concept"],
    desc: "Three directions for the same brief, each with a mood frame, the script and what it will cost.",
    render() {
      const C = [
        ["The 2am shift", "office", 3, "Cinematic, warm, quiet", "A shop floor after closing. One desk phone lights up. We cut to the Coworker answering — and the owner sleeping through it.", "Your phones never sleep. Neither do we.", "Slow push-in, shallow depth, practical light", "$2.40", "≈4 min"],
        ["Ask it anything", "phone", 4, "Phone-first, fast, captioned", "Someone types a messy real question with one thumb. The answer arrives before they put the phone down.", "Ask it like a person. It answers like an engineer.", "Handheld, screen-recorded inserts", "$1.90", "≈3 min"],
        ["One number, one answer", "support", 5, "Graphic, bright, techy", "Support panels assemble around a person with a headset, then collapse into the Loopcom mark.", "One number. One answer. Every time.", "Locked off, motion-graphic build", "$2.10", "≈3 min"],
      ];
      return `<div class="grid g3">${C.map(([t, sc, sd, tone, d, vo, cam, cost, time], i) => `
        <div class="card" style="padding:0;overflow:hidden">
          <div class="thumb" style="border-radius:0">${art(sc, sd, i === 0 ? 'data-anim="1"' : "")}<span class="badge">${ic("film", "sm")}Concept ${String.fromCharCode(65 + i)}</span></div>
          <div style="padding:14px;display:grid;gap:10px">
            <div><div class="row"><h3 style="font-size:16px">${t}</h3>${i === 0 ? '<span class="pill ok" style="margin-left:auto">Recommended</span>' : ""}</div><span class="pill info nub" style="margin-top:6px">${tone}</span></div>
            <p class="muted" style="font-size:13px">${d}</p>
            <div><div class="seclbl">Voiceover</div><blockquote style="margin:0;border-left:3px solid var(--accent);padding:6px 12px;background:var(--accent-soft);border-radius:0 8px 8px 0;font-size:13px">“${vo}”</blockquote></div>
            <div><div class="seclbl">Camera</div><p class="muted" style="font-size:12.5px">${cam}</p></div>
            <dl class="kv" style="font-size:12.5px"><dt>Estimate</dt><dd>${cost}</dd><dt>Render time</dt><dd>${time}</dd><dt>Shots</dt><dd>3 × 5s</dd></dl>
            <div class="row"><button class="btn primary sm" type="button" data-go="storyboard">Use this${ic("arrowr", "sm")}</button><button class="btn sm" type="button">${ic("refresh", "sm")}Another like this</button></div>
          </div></div>`).join("")}</div>
      <div class="note info" style="margin-top:14px">${ic("brain")}<div><b>Why these three:</b> you have picked cinematic over graphic four times out of five, and you rejected two concepts with heavy typography in August. Concept A leads for that reason. <button class="btn sm ghost" type="button" data-go="memory">What else it has learned</button></div></div>`;
    },
  });

  /* =============== 4. STORYBOARD =============== */
  const SHOTS15 = [
    { n: 1, d: 5, t: "Night shop floor", p: "Empty shop floor after closing, one desk phone lights up and rings. Slow push-in, practical light, shallow depth of field.", sc: "office", sd: 3, st: "done" },
    { n: 2, d: 5, t: "The Coworker answers", p: "Support panels resolve around a person with a headset. Calm, blue key light, no on-screen text.", sc: "support", sd: 5, st: "done" },
    { n: 3, d: 5, t: "Logo end card", p: "Loopcom mark on near-black with the infinity glow, one line of type underneath.", sc: "loop", sd: 2, st: "done" },
  ];
  const SHOTS60 = [
    { n: 1, d: 8, t: "Night shop floor", p: "Empty shop floor after closing, one desk phone lights up and rings.", sc: "office", sd: 3, st: "done" },
    { n: 2, d: 12, t: "The call is answered", p: "Support panels resolve around a person with a headset; the caller's problem appears as plain language.", sc: "support", sd: 5, st: "done" },
    { n: 3, d: 10, t: "Owner asleep", p: "Same building, upstairs. Phone face-down on the nightstand, no notifications.", sc: "phone", sd: 4, st: "render" },
    { n: 4, d: 15, t: "Morning: it's already fixed", p: "Daylight, team walks in, the board shows every call handled overnight.", sc: "team", sd: 11, st: "fail" },
    { n: 5, d: 15, t: "Logo end card", p: "Loopcom mark, one line of type, blue glow, hold.", sc: "loop", sd: 2, st: "todo" },
  ];
  R("storyboard", {
    icon: "film", nav: "Storyboard", title: "Storyboard",
    crumb: ["Creative Studio", "AI support commercial", "Storyboard"],
    desc: "One card per shot. A single generated clip is capped at 15 seconds — longer films are simply more shots, and the Coworker works out the split for you.",
    actions: `<button class="btn" type="button" id="sbLen">${ic("clock", "sm")}Show the 60-second version</button><button class="btn primary" type="button">${ic("play", "sm")}Render all</button>`,
    render() { return `<div id="sbHost"></div>`; },
    init(root) {
      let long = false, shots = SHOTS15.map((s) => ({ ...s })), sel = 1;
      const host = $("#sbHost", root);
      const stPill = (st) => st === "done" ? `<span class="pill ok">Ready</span>` : st === "render" ? `<span class="pill warn">Rendering 62%</span>` : st === "fail" ? `<span class="pill bad">Failed</span>` : `<span class="pill">Not rendered</span>`;
      function draw() {
        const total = shots.reduce((a, s) => a + s.d, 0);
        host.innerHTML = `<div class="row wrap" style="margin-bottom:10px"><span class="pill info nub">${ic("film", "sm")}${shots.length} shots · ${total}s total</span>
          <span class="pill nub">${ic("dollar", "sm")}Estimate ${CS.money(total * 0.16)}</span>
          <span class="help">Drag a card to re-order. Every clip here is 15s or shorter, which is the engine limit — Loopcom hides the join.</span></div>
        <div class="shots" id="shotStrip">${shots.map((s, i) => `
          ${i ? `<div class="transition"><button type="button">${ic("arrowr", "sm")}${i === 1 ? "Cut" : i === 2 ? "Dissolve 0.4s" : "Cut"}</button><span class="faint">transition</span></div>` : ""}
          <div class="shot ${sel === s.n ? "sel" : ""}" draggable="true" data-n="${s.n}">
            <div class="sh">${ic("grip", "sm")}<span>Shot ${s.n}</span><span class="pill nub" style="margin-left:auto">${s.d}s</span></div>
            <div class="thumb" style="border-radius:0">${art(s.sc, s.sd, s.st === "fail" ? 'data-glitch="1"' : "")}${s.st === "render" ? '<span class="badge">Rendering</span>' : ""}<span class="dur">${s.d}s</span></div>
            <div class="sb"><b style="font-size:12.5px">${s.t}</b><div class="prompt">${s.p}</div>${stPill(s.st)}
              <div class="row" style="gap:6px"><span class="capchip">${ic("image", "sm")}Ref frame</span><span class="capchip">${ic("users", "sm")}Same person</span></div></div>
            <div class="acts"><button class="btn sm" type="button" data-act="regen">${ic("refresh", "sm")}Regenerate</button><button class="btn sm" type="button" data-act="var">${ic("copy", "sm")}Variation</button><button class="btn sm" type="button" data-act="more">${ic("more", "sm")}</button></div>
          </div>`).join("")}
          <div class="transition"><button type="button">${ic("plus", "sm")}Add shot</button></div></div>
        <div class="card" style="margin-top:14px"><div class="card-h"><h3>Everything under the picture</h3><span class="sub">Laid over the whole film, not per shot</span></div>
          <div class="lanes">${[["Voiceover", "mic", "--k-vo", [["“Your phones never sleep.”", 46], ["“Neither do we.”", 30]]],
            ["Music", "music", "--k-music", [["Slow build — ducked under the voice", 100]]],
            ["Sound effects", "wave", "--k-sfx", [["Phone ring", 22], ["Room tone", 60]]],
            ["Captions", "cc", "--k-cap", [["Burned in · your caption style", 78]]],
            ["Graphics", "layout", "--k-gfx", [["Logo end card", 26]]]].map(([n, i, c, segs]) => `
            <div class="lane"><span class="lname">${ic(i, "sm")}${n}</span><div class="lbar" style="flex:1">${segs.map(([t, w]) => `<div class="lseg" style="background:var(${c});width:${w}%">${esc(t)}</div>`).join("")}</div></div>`).join("")}</div>
          <div class="row wrap" style="margin-top:12px"><button class="btn sm" type="button" data-go="audio">${ic("mic", "sm")}Voice, music & captions</button><button class="btn sm" type="button" data-go="timeline">${ic("film", "sm")}Open the timeline</button></div></div>`;
        CS.hydrate(host);
        $$(".shot", host).forEach((cardEl) => {
          cardEl.addEventListener("click", (e) => { const a = e.target.closest("[data-act]"); sel = +cardEl.dataset.n; if (a) { const act = a.dataset.act; if (act === "more") return menu(cardEl); CS.toast(act === "regen" ? `Re-rendering shot ${sel} — about 50 seconds, $0.80` : `Making 3 variations of shot ${sel}`, "refresh"); } draw(); });
          cardEl.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", cardEl.dataset.n); cardEl.classList.add("drag"); });
          cardEl.addEventListener("dragend", () => cardEl.classList.remove("drag"));
          cardEl.addEventListener("dragover", (e) => e.preventDefault());
          cardEl.addEventListener("drop", (e) => {
            e.preventDefault(); const from = +e.dataTransfer.getData("text/plain"), to = +cardEl.dataset.n; if (from === to) return;
            const fi = shots.findIndex((s) => s.n === from), ti = shots.findIndex((s) => s.n === to);
            shots.splice(ti, 0, shots.splice(fi, 1)[0]); shots.forEach((s, i) => (s.n = i + 1)); sel = to; draw(); CS.toast("Shots re-ordered", "move");
          });
        });
      }
      function menu(cardEl) {
        CS.modal({
          title: `Shot ${cardEl.dataset.n}`,
          body: `<div class="stack">${[["refresh", "Regenerate", "Same prompt, new seed — $0.80"], ["copy", "Make 3 variations", "Pick the best of four — $2.40"], ["expand", "Extend by 5 seconds", "Continues from the last frame — $0.80"], ["wand", "Revise with a note", "“Slower camera, keep the light”"], ["copy", "Duplicate", "Free"], ["trash", "Delete", "Removes the shot and its clip"]].map(([i, t, d]) => `<button class="btn" type="button" style="justify-content:flex-start">${ic(i, "sm")}<span><b>${t}</b> <span class="faint" style="font-weight:400">— ${d}</span></span></button>`).join("")}</div>`,
        });
      }
      draw();
      $("#sbLen", root).onclick = (e) => { long = !long; shots = (long ? SHOTS60 : SHOTS15).map((s) => ({ ...s })); sel = 1; e.currentTarget.innerHTML = ic("clock", "sm") + (long ? "Show the 15-second version" : "Show the 60-second version"); draw(); };
    },
  });

  /* =============== 5. PROJECTS + PROJECT WORKSPACE =============== */
  R("projects", {
    icon: "folder", nav: "Projects", title: "Projects",
    crumb: ["Creative Studio", "Projects"],
    desc: "Everything this company has made. Saved automatically, versioned, and visible only to people you allow.",
    actions: `<button class="btn primary" type="button">${ic("plus", "sm")}New project</button>`,
    render() {
      const rows = [["AI support commercial", "Video · 15s", "Jacob L.", "Coworker + Jacob", "In review", "2 minutes ago", "office", 3],
        ["Spring desk-phone promo", "Design · flyer + 4 sizes", "Jacob L.", "Jacob", "Draft", "Yesterday", "product", 7],
        ["Yiddish support explainer", "Video · 30s", "Ezra W.", "Coworker", "Rendering", "18 minutes ago", "support", 5],
        ["Careers post", "Design · 1080×1350", "Jacob L.", "Coworker", "Exported", "3 days ago", "team", 11],
        ["Sukkos hours notice", "Social · 3 sizes", "Ezra W.", "Jacob", "Exported", "1 week ago", "city", 9]];
      return `<div class="row wrap" style="margin-bottom:12px"><div class="chips" data-single>${["All", "Video", "Design", "Images", "Mine", "Shared with me"].map((t, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${t}</button>`).join("")}</div>
        <span class="chip nub" style="margin-left:auto">${ic("shield", "sm")}Loopcom Demo only</span></div>
      <div class="twrap"><table class="t"><thead><tr><th>Project</th><th>Kind</th><th>Owner</th><th>Last edited by</th><th>Status</th><th class="r">Updated</th><th></th></tr></thead><tbody>
        ${rows.map(([t, k, o, e, s, u, sc, sd]) => `<tr><td><div class="row"><div class="thumb" style="width:52px;flex:none">${art(sc, sd)}</div><b>${t}</b></div></td><td class="muted">${k}</td><td class="muted">${o}</td><td class="muted">${e}</td>
          <td><span class="pill ${s === "Exported" ? "ok" : s === "Rendering" ? "warn" : s === "In review" ? "info" : ""}">${s}</span></td><td class="r muted">${u}</td>
          <td class="r"><button class="btn sm" type="button" data-go="project">Open</button></td></tr>`).join("")}
      </tbody></table></div>`;
    },
  });
  R("project", {
    icon: "folder", nav: "Project", title: "AI support commercial", bare: false,
    crumb: ["Creative Studio", "Projects", "AI support commercial"],
    desc: "One project holds the brief, the storyboard, every generation, the designs, the timeline and the exports.",
    actions: `<span class="pill ok nub" id="saveState">${ic("check", "sm")}Saved</span><button class="btn" type="button" data-go="versions">${ic("history", "sm")}History</button><button class="btn primary" type="button" data-go="export">${ic("download", "sm")}Export</button>`,
    render() {
      return `<div class="tabs" id="pTabs" role="tablist" style="max-width:840px;margin-bottom:14px">${["Brief", "Storyboard", "Generations", "Assets", "Designs", "Timeline", "Audio", "Versions", "Comments", "Exports"].map((t, i) => `<button role="tab" type="button" aria-selected="${i === 0}">${t}</button>`).join("")}</div>
      <div id="pBody"></div>`;
    },
    init(root) {
      const body = $("#pBody", root);
      const views = {
        Brief: () => `<div class="grid g2"><div class="card"><div class="card-h"><h3>The brief</h3><span class="end"><button class="btn sm ghost" type="button">${ic("type", "sm")}Edit</button></span></div>
            <div class="stack"><p style="font-size:13.5px">A professional <b>15-second commercial</b> for Loopcom about AI technical support. Cinematic, real people, no flashy typography. Ends on the Loopcom mark.</p>
            <div class="kv"><dt>Asked by</dt><dd>Jacob L. · in the Coworker</dd><dt>Audience</dt><dd>Small business owners</dd><dt>Where it runs</dt><dd>WhatsApp Status, YouTube</dd><dt>Brand kit</dt><dd>Loopcom — Signal Core</dd><dt>Spend so far</dt><dd>$3.29</dd></div></div></div>
          <div class="card"><div class="card-h"><h3>Who did what</h3></div><div class="stack" style="gap:8px">
            ${[["cw", "Coworker", "Wrote 3 concepts, storyboarded, rendered 3 shots, added voice and music"], ["JL", "Jacob L.", "Picked concept A, asked for a smaller logo, approved the spend"], ["cw", "Coworker", "Re-rendered the end card and exported 2 sizes"]].map(([a, n, d]) => `<div class="row" style="align-items:flex-start"><span class="avatar ${a === "cw" ? "cw" : ""}">${a === "cw" ? ic("loop", "sm") : a}</span><div><b style="font-size:12.5px">${n}</b><p class="muted" style="font-size:12.5px">${d}</p></div></div>`).join("")}</div></div></div>`,
        Generations: () => `<div class="card"><div class="card-h"><h3>Every generation in this project</h3><span class="sub">Kept so any result can be reproduced exactly</span></div>
          <div class="twrap"><table class="t"><thead><tr><th>Output</th><th>What was asked</th><th>Engine</th><th>Seed</th><th>Took</th><th class="r">Cost</th><th></th></tr></thead><tbody>
          ${[["office", 3, "Shot 1 — night shop floor", "Loopcom video · production", "418823", "51s", "$0.80", "Used"], ["support", 5, "Shot 2 — take 2 (take 1 failed the hand check)", "Loopcom video · production", "992014", "56s", "$0.80", "Used"], ["support", 6, "Shot 2 — take 1", "Loopcom video · production", "771004", "49s", "$0.80", "Rejected"], ["loop", 2, "Shot 3 — logo end card", "Loopcom video · production", "120945", "44s", "$0.80", "Replaced"]]
            .map(([sc, sd, w, e, s, t, c, st]) => `<tr><td><div class="thumb" style="width:64px">${art(sc, sd)}</div></td><td>${w}</td><td class="muted">${e}</td><td class="mono">${s}</td><td class="muted">${t}</td><td class="r">${c}</td><td class="r"><span class="pill ${st === "Used" ? "ok" : st === "Rejected" ? "bad" : ""}">${st}</span></td></tr>`).join("")}
          </tbody></table></div>
          <div class="note info" style="margin-top:12px">${ic("history")}<div>Each row keeps the exact request, the prompt we built from it, the engine and version, every setting, the seed, and which reference images were used — so the same result can be made again, or turned into a variation. <button class="btn sm ghost" type="button" id="genDetail">Open one</button></div></div></div>`,
        Assets: () => `<div class="card"><div class="card-h"><h3>Files in this project</h3></div>${assetGrid(8)}</div>`,
        Designs: () => `<div class="grid g3">${[["End card", "loop", 2], ["Thumbnail", "office", 3], ["Static cutdown", "support", 5]].map(([t, sc, sd]) => `<div class="card" style="padding:0;overflow:hidden"><div class="thumb" style="border-radius:0">${art(sc, sd)}</div><div style="padding:10px"><b>${t}</b><div class="row" style="margin-top:8px"><button class="btn sm" type="button" data-go="design">${ic("layout", "sm")}Open in editor</button></div></div></div>`).join("")}</div>`,
        Timeline: () => `<div class="note info">${ic("film")}<div>The timeline lives on its own screen. <button class="btn sm" type="button" data-go="timeline">Open the video editor</button></div></div>`,
        Audio: () => `<div class="note info">${ic("mic")}<div>Voiceover, music, sound effects and captions. <button class="btn sm" type="button" data-go="audio">Open</button></div></div>`,
        Storyboard: () => `<div class="note info">${ic("grid")}<div>Three shots, 15 seconds. <button class="btn sm" type="button" data-go="storyboard">Open the storyboard</button></div></div>`,
        Versions: () => `<div class="note info">${ic("history")}<div>17 versions, 9 of them by the Coworker. <button class="btn sm" type="button" data-go="versions">Open history</button></div></div>`,
        Comments: () => `<div class="card"><div class="card-h"><h3>Comments</h3></div><div class="stack">
          ${[["EW", "Ezra W.", "Can the end card hold a beat longer? It cuts off fast on a phone.", "Yesterday 4:12 PM", "Shot 3"], ["JL", "Jacob L.", "Agreed — Coworker already fixed it in v16.", "Yesterday 4:20 PM", ""]].map(([a, n, t, w, on]) => `<div class="row" style="align-items:flex-start"><span class="avatar">${a}</span><div style="flex:1"><div class="row"><b style="font-size:12.5px">${n}</b>${on ? `<span class="pill info nub">${on}</span>` : ""}<span class="faint" style="margin-left:auto;font-size:11.5px">${w}</span></div><p style="font-size:13px;margin-top:3px">${t}</p></div></div>`).join("")}
          <div class="input" style="display:flex;align-items:center;color:var(--text-faint)">Write a comment…</div></div></div>`,
        Exports: () => `<div class="card"><div class="card-h"><h3>Exports</h3></div><div class="twrap"><table class="t"><thead><tr><th>Preset</th><th>Size</th><th>Format</th><th>Made</th><th class="r"></th></tr></thead><tbody>
          ${[["WhatsApp Status", "1080×1920", "MP4 · H.264", "2 minutes ago"], ["YouTube", "1920×1080", "MP4 · H.264", "2 minutes ago"], ["Captions", "—", "SRT", "2 minutes ago"]].map(([p, s, f, m]) => `<tr><td><b>${p}</b></td><td class="muted">${s}</td><td class="muted">${f}</td><td class="muted">${m}</td><td class="r"><button class="btn sm" type="button">${ic("download", "sm")}Download</button></td></tr>`).join("")}</tbody></table></div></div>`,
      };
      const show = (name) => { body.innerHTML = (views[name] || views.Brief)(); CS.hydrate(body); $$("[data-go]", body).forEach((b) => (b.onclick = () => CS.go(b.dataset.go))); const gd = $("#genDetail", body); if (gd) gd.onclick = genDetail; };
      $$("#pTabs button", root).forEach((b) => b.addEventListener("click", () => { $$("#pTabs button", root).forEach((x) => x.setAttribute("aria-selected", x === b)); show(b.textContent.trim()); }));
      show("Brief");
      CS.every(() => { const s = $("#saveState", root); if (!s) return; s.innerHTML = ic("refresh", "sm") + "Saving…"; CS.later(() => (s.innerHTML = ic("check", "sm") + "Saved"), 900); }, 9000);
    },
  });
  function genDetail() {
    CS.modal({
      title: "Generation record", wide: true,
      body: `<div class="grid g2"><div>${CS.player("support", 5, { dur: "0:05", anim: true })}</div>
        <div class="stack"><div class="kv"><dt>What you asked</dt><dd style="text-align:left">“Shot 2 — the Coworker answers”</dd><dt>Engine</dt><dd>Loopcom video · production (Sora 2)</dd><dt>Version</dt><dd class="mono">2026-08-14</dd><dt>Seed</dt><dd class="mono">992014</dd><dt>Duration</dt><dd>5s · 1080p · 16:9</dd><dt>Worker</dt><dd class="mono">hosted-api-us</dd><dt>Render time</dt><dd>56s</dd><dt>Cost</dt><dd>$0.80</dd><dt>References</dt><dd>2 (person, office)</dd></div>
        <details class="adv" open><summary>${ic("chevd", "sm")}The prompt we built for you</summary><div class="body"><p class="mono" style="font-size:11.5px;line-height:1.5">Cinematic 5s shot, night interior, small business shop floor. Person with headset lit by a single cool key light, support panels resolving softly around them. Slow push-in, 35mm, shallow depth of field, practical light, film grain. Brand palette #22A8FF/#4F7BFF. No on-screen text, no logos other than supplied. Negative: warped hands, extra fingers, text artefacts, flicker.</p>
        <p class="help" style="margin-top:8px">Built from your words plus the brand kit and three learned preferences. You never have to write this.</p></div></details>
        <div class="row wrap"><button class="btn sm">${ic("refresh", "sm")}Make it again</button><button class="btn sm">${ic("copy", "sm")}Variation</button><button class="btn sm">${ic("wand", "sm")}Revise with a note</button></div></div></div>`,
    });
  }

  /* =============== 6. ASSETS =============== */
  function assetGrid(n) {
    const A = [["Shot 1 — night floor", "office", 3, "Video · 5s", "Generated"], ["Shot 2 — take 2", "support", 5, "Video · 5s", "Generated"], ["Logo end card", "loop", 2, "Video · 5s", "Generated"],
      ["Desk phone — front", "product", 7, "Image · PNG", "Uploaded"], ["Desk phone — cut out", "product", 8, "Image · transparent", "Generated"], ["Team, Aug 2026", "team", 11, "Image · JPG", "Uploaded"],
      ["Storefront dusk", "city", 9, "Image · JPG", "Stock · licensed"], ["Phone in hand", "phone", 4, "Image · PNG", "Generated"], ["Support panels", "support", 6, "Image · PNG", "Generated"]];
    return `<div class="agrid">${A.slice(0, n).map(([t, sc, sd, k, src]) => `<div class="asset"><div class="thumb">${art(sc, sd)}${k.startsWith("Video") ? `<span class="badge">${ic("video", "sm")}5s</span>` : ""}</div>
      <div class="ab"><b>${t}</b><div class="row" style="margin-top:4px"><span class="faint">${k}</span><span class="pill ${src.startsWith("Stock") ? "warn" : src === "Uploaded" ? "" : "info"} nub" style="margin-left:auto">${src}</span></div></div></div>`).join("")}</div>`;
  }
  R("assets", {
    icon: "layers", nav: "Assets", title: "Asset library",
    crumb: ["Creative Studio", "Assets"],
    desc: "Everything you have uploaded or made. Files are stored per company — nobody outside Loopcom Demo can list them, link them or guess their address.",
    actions: `<button class="btn" type="button" id="upBtn">${ic("upload", "sm")}Upload</button><button class="btn primary" type="button" data-go="image">${ic("image", "sm")}Make an image</button>`,
    render() {
      return `<div class="row wrap" style="margin-bottom:12px"><div class="chips" data-single>${["Everything", "Images", "Video", "Audio", "Logos", "Uploaded", "Generated", "Licensed stock"].map((t, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${t}</button>`).join("")}</div></div>
      ${assetGrid(9)}
      <div class="card" style="margin-top:16px"><div class="card-h"><h3>Things that must stay the same</h3><span class="sub">Reference libraries — a campaign should not look like unrelated AI pictures</span><span class="end"><button class="btn sm">${ic("plus", "sm")}Add a reference</button></span></div>
        <div class="grid g4">${[["Spokesperson — “Malky”", "support", 5, "6 reference frames · locked", "users"], ["Product — T54W desk phone", "product", 7, "12 angles · locked", "tag"], ["Our office", "office", 3, "4 frames", "camera"], ["The Loopcom mark", "loop", 2, "Never redrawn — only placed", "shield"]]
          .map(([t, sc, sd, m, i]) => `<div class="card" style="padding:0;overflow:hidden"><div class="thumb" style="border-radius:0">${art(sc, sd)}</div><div style="padding:10px"><div class="row">${ic(i, "sm")}<b style="font-size:12.5px">${t}</b></div><p class="help" style="margin-top:4px">${m}</p></div></div>`).join("")}</div>
        <div class="note warn" style="margin-top:12px">${ic("shield")}<div><b>A person's likeness needs a record.</b> Before a real person can be used as a spokesperson reference, the studio asks who they are and who confirmed permission. That record is kept with the reference.</div></div></div>`;
    },
    init(root) { $("#upBtn", root).onclick = uploadModal; },
  });
  function uploadModal() {
    CS.modal({
      title: "Upload files",
      body: `<div class="stack"><div class="drop" style="padding:22px;justify-content:center">${ic("upload")}<div><b>Drop files here</b><div class="help">Images, video, audio or fonts · up to 500 MB each</div></div></div>
        <div class="stack" id="upList">${[["team-photo-aug.jpg", "4.2 MB", "checked"], ["price-list.pdf", "880 KB", "scanning"], ["promo-cut.mov", "180 MB", "converting"]].map(([n, s, st]) => `
          <div class="row"><span class="faint">${ic("file", "sm")}</span><div style="flex:1"><b style="font-size:12.5px">${n}</b><div class="help">${s}</div></div>
            ${st === "checked" ? `<span class="pill ok">Ready</span>` : st === "scanning" ? `<span class="pill warn">${ic("shield", "sm")}Checking the file</span>` : `<span class="pill info">Converting</span>`}</div>`).join("")}</div>
        <div class="note info">${ic("shield")}<div>Every uploaded file is treated as untrusted: we check what it really is rather than trusting its name, strip anything hidden inside it, re-encode images and video ourselves, and store it under this company only. Text inside an uploaded document is read as <b>information, never as instructions</b> to the Coworker.</div></div></div>`,
      footer: `<span class="help" style="margin-right:auto">3 files · 185 MB</span><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="button" data-close>Add to library</button>`,
    });
  }

  /* =============== 7. BRAND KIT =============== */
  const KITS = {
    loopcom: { name: "Loopcom — Signal Core", who: "Loopcom LLC", colors: [["Signal blue", "#22A8FF"], ["Deep blue", "#4F7BFF"], ["Near-black", "#0C1218"], ["Panel", "#141F2B"], ["Paper", "#F6F8FB"]], fonts: [["Inter", "Headlines · 700"], ["Inter", "Body · 400/500"]], voice: "Plain English. Short sentences. Never call the product “AI-powered”. Say what it does.", no: ["Neon gradients", "Stock smiles", "Comic fonts", "Heavy drop shadows", "Tagline typed by hand — it is baked into the logo"], claims: ["Answers your phones day and night", "Set up in a day", "Works on the phones you already have"], ctas: ["Talk to us", "See it working", "Start free"], legal: "Loopcom LLC · Prices exclude taxes and fees where shown separately." },
    demo: { name: "Loopcom Demo — internal", who: "Loopcom Demo (this workspace)", colors: [["Demo teal", "#1B9E8F"], ["Ink", "#12202B"], ["Sand", "#F3EFE7"]], fonts: [["Inter", "Headlines"], ["Inter", "Body"]], voice: "Friendly, direct, no jargon.", no: ["Loopcom production logo", "Customer photos"], claims: ["Example content only"], ctas: ["Try it"], legal: "Internal demo material — not for customers." },
  };
  R("brand", {
    icon: "palette", nav: "Brand kit", title: "Brand kit",
    crumb: ["Creative Studio", "Brand kit"],
    desc: "The look everything is made in. Each company has its own — no part of it is visible to any other company on Loopcom.",
    actions: `<button class="btn" type="button" id="kitSwitch">${ic("copy", "sm")}Switch kit</button><button class="btn primary" type="button">${ic("check", "sm")}Save</button>`,
    render() { return `<div id="kitHost"></div>`; },
    init(root) {
      let cur = "loopcom";
      const host = $("#kitHost", root);
      function draw() {
        const k = KITS[cur];
        host.innerHTML = `<div class="row wrap" style="margin-bottom:12px"><span class="pill info nub">${ic("palette", "sm")}${k.name}</span><span class="pill nub">${ic("lock", "sm")}Visible to ${k.who} only</span>
          <span class="help">Switching kits here is only to show the separation — in the real portal you only ever see your own.</span></div>
        <div class="grid g2">
          <div class="card"><div class="card-h"><h3>Logos</h3><span class="end"><button class="btn sm">${ic("upload", "sm")}Add</button></span></div>
            <div class="grid g2" style="gap:10px">
              <div><div style="background:#0c1218;border-radius:10px;padding:16px;display:grid;place-items:center"><img src="brand/loopcom-nav-h64@2x.png" alt="Loopcom logo on dark" style="max-width:100%;height:auto"></div><div class="help" style="margin-top:5px">Primary · on dark</div></div>
              <div><div style="background:#fff;border-radius:10px;padding:16px;display:grid;place-items:center;border:1px solid var(--border)"><img src="brand/loopcom-nav-h64@2x-light.png" alt="Loopcom logo on light" style="max-width:100%;height:auto"></div><div class="help" style="margin-top:5px">Alternate · on light</div></div>
              <div><div style="background:#0c1218;border-radius:10px;padding:12px;display:grid;place-items:center"><img src="brand/loopcom-icon-256.png" alt="Loopcom mark" style="width:84px;height:auto"></div><div class="help" style="margin-top:5px">Mark only</div></div>
              <div class="note warn" style="align-self:center">${ic("alert", "sm")}<div style="font-size:12px">The tagline is part of the artwork. Nothing may type a second one underneath.</div></div>
            </div></div>
          <div class="card"><div class="card-h"><h3>Colours</h3></div>
            <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:10px">${k.colors.map(([n, c]) => `<div class="swrow"><div class="swatch" style="background:${c}"></div><b style="font-size:12px">${n}</b><span class="mono faint">${c}</span></div>`).join("")}</div>
            <div class="divider"></div><div class="card-h"><h3>Fonts</h3></div>
            <div class="stack" style="gap:8px">${k.fonts.map(([f, u]) => `<div class="row"><span style="font-size:20px;font-weight:700">Aa</span><div><b style="font-size:12.5px">${f}</b><div class="help">${u}</div></div><button class="btn sm ghost" style="margin-left:auto">${ic("more", "sm")}</button></div>`).join("")}</div></div>
        </div>
        <div class="grid g3" style="margin-top:14px">
          <div class="card"><div class="card-h"><h3>How we write</h3></div><p style="font-size:13px">${k.voice}</p>
            <div class="divider"></div><div class="seclbl">Approved lines</div><div class="stack" style="gap:6px">${k.claims.map((c) => `<span class="chip nub" style="justify-content:flex-start">${ic("check", "sm")}${c}</span>`).join("")}</div>
            <div class="seclbl" style="margin-top:12px">Buttons we use</div><div class="chips">${k.ctas.map((c) => `<span class="chip nub">${c}</span>`).join("")}</div></div>
          <div class="card"><div class="card-h"><h3>Never do this</h3></div><div class="stack" style="gap:6px">${k.no.map((n) => `<span class="chip nub" style="justify-content:flex-start;color:var(--danger)">${ic("ban", "sm")}${n}</span>`).join("")}</div>
            <div class="divider"></div><div class="seclbl">Small print</div><p class="muted" style="font-size:12.5px">${k.legal}</p></div>
          <div class="card"><div class="card-h"><h3>Pictures we approve of</h3><span class="sub">Used as style references</span></div>
            <div class="grid g2" style="gap:8px">${[["office", 3], ["product", 7], ["team", 11], ["city", 9]].map(([sc, sd]) => `<div class="thumb">${art(sc, sd)}</div>`).join("")}</div>
            <div class="divider"></div><div class="seclbl">Templates</div><div class="stack" style="gap:6px">${["15s ad — cinematic", "Flyer — product", "Story — 9:16"].map((t) => `<span class="chip nub" style="justify-content:flex-start">${ic("template", "sm")}${t}</span>`).join("")}</div></div>
        </div>
        <div class="note ok" style="margin-top:14px">${ic("shield")}<div><b>Separation is enforced on the server, not in the screen.</b> A request for another company's brand kit, asset or project comes back as “not found”, whether it comes from a person, the Coworker, or a link someone was sent.</div></div>`;
        CS.hydrate(host);
      }
      draw();
      $("#kitSwitch", root).onclick = () => { cur = cur === "loopcom" ? "demo" : "loopcom"; draw(); CS.toast("Showing " + KITS[cur].name, "palette"); };
    },
  });

  /* =============== 8. CREATIVE MEMORY =============== */
  R("memory", {
    icon: "brain", nav: "Creative memory", title: "What the studio has learned",
    crumb: ["Creative Studio", "Creative memory"],
    desc: "Every time you accept, reject, re-do or hand-edit something, the studio notices. You can read all of it, change it, pin it, or throw it away.",
    actions: `<button class="btn" type="button" id="memReset">${ic("refresh", "sm")}Start over</button>`,
    render() {
      const L = [
        ["Prefers cinematic advertising", "You picked the cinematic concept in 5 of 6 videos and rejected 2 graphic ones.", "you", "pinned", "spark"],
        ["Real people, not illustrations", "9 accepted images have people in them; 3 illustrated ones were re-done.", "you", "on", "users"],
        ["Avoid flashy typography", "You shrank or removed the headline in 6 of the last 8 designs.", "company", "on", "type"],
        ["The logo should not dominate the end card", "Asked for a smaller mark twice, most recently 2 minutes ago.", "company", "on", "shield"],
        ["Usually 9:16 for WhatsApp Status", "11 of 12 status exports.", "you", "on", "smartphone"],
        ["Understated transitions", "You replaced 4 wipes with cuts or short dissolves.", "you", "on", "film"],
        ["Slower camera movement", "Two re-renders asked for a slower push-in.", "you", "new", "camera"],
      ];
      return `<div class="grid g2" style="align-items:start">
        <div class="stack">
          <div class="card"><div class="card-h"><h3>About your work</h3><span class="sub">Applied to everything it makes for you</span></div>
            <div class="stack" style="gap:8px" id="memList">${L.map(([t, why, scope, st, i], k) => `
              <div class="memitem ${st === "new" ? "sug" : ""}" data-k="${k}">
                <span class="dot-scope" title="${scope === "company" ? "Company rule" : "Your preference"}">${ic(scope === "company" ? "users" : "eye", "sm")}</span>
                <div><div class="row"><b style="font-size:13px">${t}</b>${st === "pinned" ? `<span class="pill info nub">${ic("pin", "sm")}Pinned</span>` : st === "new" ? `<span class="pill warn nub">Suggested</span>` : ""}</div><div class="why">${why}</div></div>
                <div class="acts">${st === "new" ? `<button class="btn sm primary" type="button" data-m="keep">Keep</button><button class="btn sm" type="button" data-m="drop">No</button>` :
                  `<button class="iconbtn" type="button" data-m="pin" aria-label="Pin">${ic("pin", "sm")}</button><button class="iconbtn" type="button" data-m="edit" aria-label="Edit">${ic("type", "sm")}</button><button class="iconbtn" type="button" data-m="drop" aria-label="Remove">${ic("trash", "sm")}</button>`}</div></div>`).join("")}</div>
            <div class="note info" style="margin-top:12px">${ic("brain")}<div>A preference only becomes a rule after it has happened <b>three times</b>. Anything that would apply to the whole company waits for an admin to agree.</div></div></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>Where memory lives</h3><span class="sub">Kept apart on purpose</span></div>
            <div class="stack" style="gap:8px">${[["This task", "What we're working on right now. Gone when the task ends.", "clock", "7 notes"],
              ["Your preferences", "Just yours. Other people in the company have their own.", "eye", "6 learned"],
              ["Company rules", "Brand rules everyone here gets. Needs an admin.", "users", "2 rules"],
              ["What works", "Which way of making a thing turned out best.", "activity", "14 recipes"],
              ["Engine scorecard", "Which engine is fastest and most reliable for each job.", "cpu", "platform-wide"],
              ["This project", "Decisions taken inside one project.", "folder", "4 notes"],
              ["Your corrections", "Accepted, rejected, re-done, hand-edited.", "thumbup", "213 signals"]]
              .map(([t, d, i, m]) => `<div class="row" style="align-items:flex-start"><span class="dot-scope">${ic(i, "sm")}</span><div style="flex:1"><b style="font-size:12.5px">${t}</b><div class="help">${d}</div></div><span class="pill nub">${m}</span></div>`).join("")}</div>
            <div class="note warn" style="margin-top:12px">${ic("shield")}<div>The engine scorecard is the only thing shared beyond your company, and it only carries <b>how fast and how reliable</b> an engine was — never your prompts, pictures or projects.</div></div></div>
          <div class="card"><div class="card-h"><h3>Learning</h3></div>
            <div class="stack" style="gap:10px">
              <div class="row"><div style="flex:1"><b style="font-size:13px">Learn from what I do</b><div class="help">Off means it only uses the brand kit and what you type.</div></div>${CS.sw(true, "Learn from what I do")}</div>
              <div class="row"><div style="flex:1"><b style="font-size:13px">Ask before a company-wide rule</b><div class="help">Recommended. Personal preferences are applied straight away.</div></div>${CS.sw(true, "Ask before company rules")}</div>
              <div class="row"><div style="flex:1"><b style="font-size:13px">Let it pick the engine</b><div class="help">Chooses on quality, speed and cost — only from engines your admin allows.</div></div>${CS.sw(true, "Let it pick the engine")}</div>
            </div></div>
        </div></div>`;
    },
    init(root) {
      $("#memList", root).addEventListener("click", (e) => {
        const b = e.target.closest("[data-m]"); if (!b) return;
        const item = b.closest(".memitem"), act = b.dataset.m;
        if (act === "drop") { item.remove(); CS.toast("Removed — it will not be used again", "trash"); }
        else if (act === "keep") { item.classList.remove("sug"); item.querySelector(".acts").innerHTML = `<span class="pill ok nub">${ic("check", "sm")}Kept</span>`; CS.toast("Kept — it will use this from now on", "brain"); }
        else if (act === "pin") CS.toast("Pinned — it will not be replaced by newer habits", "pin");
        else if (act === "edit") CS.modal({ title: "Edit what it learned", body: `<label class="fld">In your words<textarea class="input" rows="3">Keep the Loopcom mark small on end cards — about a quarter of the width, never more.</textarea></label><div class="row wrap" style="margin-top:10px"><span class="pill nub">Applies to: the whole company</span><span class="pill nub">${ic("clock", "sm")}Learned 2 minutes ago</span></div>`, footer: `<button class="btn" data-close type="button">Cancel</button><button class="btn primary" data-close type="button">Save</button>` });
      });
      $("#memReset", root).onclick = () => CS.modal({ title: "Start over?", body: `<p>This clears everything the studio has learned about your work. Your brand kit, projects and files are not touched.</p><div class="stack" style="margin-top:12px"><label class="row"><input type="checkbox" checked> Your preferences (6)</label><label class="row"><input type="checkbox"> Company rules (2)</label><label class="row"><input type="checkbox"> What works (14 recipes)</label></div>`, footer: `<button class="btn" data-close type="button">Cancel</button><button class="btn danger" data-close type="button">Clear selected</button>` });
    },
  });

  /* =============== 9. VERSIONS =============== */
  R("versions", {
    icon: "history", nav: "Version history", title: "Version history",
    crumb: ["Creative Studio", "AI support commercial", "History"],
    desc: "Every meaningful change is a version, whoever made it. You can compare any two, go back, or branch off and try something else.",
    render() {
      const V = [["v17", "Coworker", "Exported WhatsApp Status and YouTube", "2 minutes ago", "cw"],
        ["v16", "Coworker", "End card: logo 34% → 24%, held 1.2s longer", "3 minutes ago", "cw"],
        ["v15", "Jacob L.", "Asked for a smaller logo", "3 minutes ago", "JL"],
        ["v14", "Coworker", "Added voiceover, music bed and captions", "6 minutes ago", "cw"],
        ["v13", "Coworker", "Re-rendered shot 2 — take 1 failed the hand check", "7 minutes ago", "cw"],
        ["v12", "Coworker", "Rendered shots 1–3", "9 minutes ago", "cw"],
        ["v11", "Jacob L.", "Approved $2.40 of rendering", "13 minutes ago", "JL"],
        ["v10", "Coworker", "Storyboarded 3 shots from concept A", "13 minutes ago", "cw"]];
      return `<div class="grid g2" style="align-items:start">
        <div class="card"><div class="card-h"><h3>Changes</h3><span class="sub">Newest first</span><span class="end"><button class="btn sm">${ic("branch", "sm")}Branch from v14</button></span></div>
          <div>${V.map(([v, who, what, when, a], i) => `<div class="vitem"><div class="vrail"><span class="avatar ${a === "cw" ? "cw" : ""}" style="width:24px;height:24px">${a === "cw" ? ic("loop", "sm") : a}</span>${i < V.length - 1 ? '<span class="line"></span>' : ""}</div>
            <div><div class="row"><b style="font-size:13px">${what}</b>${i === 0 ? '<span class="pill ok nub">Current</span>' : ""}</div><div class="help">${v} · ${who} · ${when}</div></div>
            <div class="row" style="gap:4px"><button class="iconbtn" type="button" aria-label="Compare">${ic("compare", "sm")}</button><button class="iconbtn" type="button" aria-label="Restore">${ic("undo", "sm")}</button><button class="iconbtn" type="button" aria-label="More">${ic("more", "sm")}</button></div></div>`).join("")}</div></div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>Compare v15 with v16</h3><span class="sub">Drag the handle</span></div>
            <div class="cmp" id="cmp"><div class="thumb" style="border-radius:0">${art("loop", 2)}</div><div class="after"><div class="thumb" style="border-radius:0">${art("loop", 6)}</div></div><div class="handle" id="cmpH"></div><input type="range" min="0" max="100" value="50" id="cmpR" aria-label="Compare position"></div>
            <div class="row" style="margin-top:10px"><span class="pill nub">v15 — logo at 34%</span><span class="pill info nub" style="margin-left:auto">v16 — logo at 24%</span></div>
            <div class="row wrap" style="margin-top:10px"><button class="btn sm">${ic("undo", "sm")}Go back to v15</button><button class="btn sm">${ic("branch", "sm")}Branch here</button><button class="btn sm">${ic("copy", "sm")}Duplicate project</button></div></div>
          <div class="card"><div class="card-h"><h3>What changed in v16</h3></div>
            <div class="oplog"><div><b>set</b> endcard.logo.width 34% → 24%</div><div><b>set</b> endcard.logo.y 612 → 572</div><div><b>set</b> timeline.shot3.duration 5.0s → 6.2s</div><div><b>set</b> audio.music.tail 0.6s → 1.8s</div><div><b>render</b> segment 10.8s–17.0s (partial re-render)</div></div>
            <p class="help" style="margin-top:8px">Made by the Coworker, on your instruction, against revision 41 of the project. If you had edited it at the same moment, its change would have been refused and it would have re-read the project first.</p></div>
        </div></div>`;
    },
    init(root) {
      const r = $("#cmpR", root), h = $("#cmpH", root), a = $(".after", root);
      const set = () => { a.style.clipPath = `inset(0 0 0 ${r.value}%)`; h.style.left = r.value + "%"; };
      r.addEventListener("input", set); set();
    },
  });

  /* =============== 10. EXPORT =============== */
  R("export", {
    icon: "download", nav: "Export", title: "Export",
    crumb: ["Creative Studio", "AI support commercial", "Export"],
    desc: "Pick where it is going and the studio sets the size, the format and the safe areas for you.",
    render() {
      const P = [["WhatsApp Status", "1080×1920", "9:16", "smartphone", 1], ["Instagram Reel", "1080×1920", "9:16", "smartphone", 0], ["Instagram post", "1080×1350", "4:5", "image", 0],
        ["Facebook", "1200×628", "1.91:1", "layout", 0], ["TikTok", "1080×1920", "9:16", "smartphone", 0], ["YouTube", "1920×1080", "16:9", "video", 1],
        ["YouTube Shorts", "1080×1920", "9:16", "video", 0], ["Landscape commercial", "3840×2160", "16:9", "film", 0], ["Square", "1080×1080", "1:1", "square", 0], ["Custom", "Any size", "—", "crop", 0]];
      return `<div class="genlay"><div class="gpanel">
        <div class="sect"><div class="seclbl">Where is it going</div><div class="stack" style="gap:6px" id="presets">
          ${P.map(([n, s, r, i, on]) => `<button class="chip ${on ? "on" : ""}" type="button" style="justify-content:flex-start" data-r="${r}" data-s="${s}">${ic(i, "sm")}<b>${n}</b><span class="faint" style="margin-left:auto">${s}</span></button>`).join("")}</div></div>
        <div class="sect"><div class="seclbl">Video</div>
          <label class="fld">Format<select class="select"><option>MP4 (H.264) — plays everywhere</option><option>MP4 (H.265) — smaller, newer devices</option><option>WebM (VP9) — web</option></select></label>
          <label class="fld">Quality<select class="select"><option>High — for posting</option><option>Maximum — for archive</option><option>Small file — for email</option></select></label>
          <div class="row"><div style="flex:1"><b style="font-size:13px">Burn captions in</b><div class="help">Also saves a separate .srt</div></div>${CS.sw(true, "Burn captions in")}</div>
          <div class="row"><div style="flex:1"><b style="font-size:13px">Match loudness</b><div class="help">−14 LUFS, the level social platforms expect</div></div>${CS.sw(true, "Match loudness")}</div></div>
        <div class="sect"><div class="seclbl">Images</div><div class="chips">${["PNG", "JPG", "WebP", "Transparent PNG", "PDF"].map((f, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${f}</button>`).join("")}</div></div>
        <div class="cost"><div><b id="expCount">2 exports</b><div class="help">About 40 seconds</div></div><button class="btn primary" type="button" style="margin-left:auto" data-go="render">${ic("download", "sm")}Export</button></div>
      </div>
      <div class="stack">
        <div class="card"><div class="card-h"><h3>How it will look</h3><span class="sub" id="expSpec">1080×1920 · 9:16</span></div>
          <div class="row wrap" style="align-items:flex-start;gap:14px">
            <div style="flex:0 0 220px"><div class="player" style="aspect-ratio:9/16" id="expPrev">${art("office", 3, 'data-anim="1"')}<div class="capline" style="bottom:120px">Your phones never sleep.</div></div>
              <p class="help" style="margin-top:6px">Re-framed from 16:9 — the person and the mark stay inside the safe area.</p></div>
            <div class="stack" style="flex:1;min-width:220px">
              <div class="note ok">${ic("check")}<div><b>Safe areas checked.</b> Nothing important sits under the platform's own buttons or the caption strip.</div></div>
              <div class="note warn">${ic("alert")}<div><b>One thing to look at.</b> In 9:16 the end-card line breaks onto two lines. The studio can shrink it by 8%, or you can leave it.</div><button class="btn sm" type="button" style="margin-left:auto">Fix it</button></div>
              <div class="kv"><dt>Length</dt><dd>0:15</dd><dt>Estimated size</dt><dd>14.2 MB</dd><dt>Frame rate</dt><dd>30 fps</dd><dt>Audio</dt><dd>Stereo AAC 192 kbps</dd></div>
            </div></div></div>
        <div class="card"><div class="card-h"><h3>Already exported</h3></div><div class="twrap"><table class="t"><tbody>
          ${[["WhatsApp Status", "1080×1920", "14.2 MB"], ["YouTube", "1920×1080", "21.8 MB"], ["Captions (.srt)", "—", "2 KB"]].map(([a, b, c]) => `<tr><td><b>${a}</b></td><td class="muted">${b}</td><td class="muted">${c}</td><td class="r"><button class="btn sm">${ic("download", "sm")}Download</button></td></tr>`).join("")}
        </tbody></table></div></div>
      </div></div>`;
    },
    init(root) {
      const sel = new Set(["WhatsApp Status", "YouTube"]);
      $("#presets", root).addEventListener("click", (e) => {
        const b = e.target.closest(".chip"); if (!b) return;
        b.classList.toggle("on"); const name = b.querySelector("b").textContent;
        b.classList.contains("on") ? sel.add(name) : sel.delete(name);
        $("#expCount", root).textContent = `${sel.size} export${sel.size === 1 ? "" : "s"}`;
        if (b.classList.contains("on")) { $("#expSpec", root).textContent = `${b.dataset.s} · ${b.dataset.r}`; const p = $("#expPrev", root); p.style.aspectRatio = b.dataset.r === "—" ? "16/9" : b.dataset.r.replace(":", "/"); }
      });
    },
  });

  /* =============== 11. RENDER PROGRESS =============== */
  R("render", {
    icon: "activity", nav: "Render progress", title: "Rendering",
    crumb: ["Creative Studio", "AI support commercial", "Rendering"],
    desc: "Long jobs run on the server. You can close Loopcom, go home, and come back to it — we'll tell you when it's done.",
    render() {
      return `<div class="grid g2" style="align-items:start"><div class="card">
        <div class="card-h"><h3>15-second commercial</h3><span class="end"><span class="pill warn" id="rPhase">Rendering</span></span></div>
        <div class="stack">
          <div><div class="row" style="margin-bottom:6px"><b style="font-size:13px" id="rLabel">Shot 2 of 3 — the Coworker answers</b><span class="num muted" style="margin-left:auto" id="rPct">62%</span></div><div class="bar"><i id="rBar" style="width:62%"></i></div>
            <div class="row" style="margin-top:6px"><span class="help" id="rEta">About 1 minute 40 seconds left</span><span class="help" style="margin-left:auto" id="rSpend">$1.60 of about $2.40</span></div></div>
          <div id="rSteps"></div>
          <div class="note info">${ic("bell")}<div>You can close this. We'll send a notification when it's finished, and it will be waiting in the project.</div></div>
          <div class="row wrap"><button class="btn" type="button" id="rCancel">${ic("x", "sm")}Cancel</button><button class="btn ghost" type="button">${ic("bell", "sm")}Notify me instead</button></div>
        </div></div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>Watching it come out</h3></div><div class="thumb">${art("support", 5, 'data-anim="1"')}</div>
            <p class="help" style="margin-top:8px">Preview frames appear as each shot finishes.</p></div>
          <div class="card"><div class="card-h"><h3>Checks after each shot</h3><span class="sub">Before you ever see it</span></div>
            <div class="stack" style="gap:7px">${[["Hands and faces", "ok"], ["Text in the picture", "ok"], ["Logo untouched", "ok"], ["Flicker between frames", "ok"], ["Same person across shots", "run"], ["Composition and framing", "todo"]].map(([t, st]) => `
              <div class="row">${st === "ok" ? `<span class="ok-ic">${ic("check", "sm")}</span>` : st === "run" ? '<span class="spin"></span>' : `<span class="faint">${ic("circle", "sm")}</span>`}<span style="font-size:12.5px">${t}</span><span class="help" style="margin-left:auto">${st === "ok" ? "passed" : st === "run" ? "checking" : "waiting"}</span></div>`).join("")}</div>
            <div class="note warn" style="margin-top:10px">${ic("refresh")}<div><b>One re-render so far.</b> Take 1 of shot 2 had a warped hand, so it was re-rendered once. The studio retries at most twice, then shows you what it got and says what is wrong with it.</div></div></div>
        </div></div>`;
    },
    init(root) {
      const steps = [{ tool: "Queue", icon: "list", label: "Waiting for a free worker", state: "8s", media: true, st: "done" },
        { tool: "Video", icon: "video", label: "Shot 1 — night shop floor", state: "51s", media: true, st: "done" },
        { tool: "Video", icon: "video", label: "Shot 2 — the Coworker answers", state: "62%", media: true, st: "run" },
        { tool: "Video", icon: "video", label: "Shot 3 — logo end card", state: "waiting", media: true, st: "todo" },
        { tool: "Render", icon: "film", label: "Join the shots, add sound and captions", state: "waiting", media: true, st: "todo" }];
      let pct = 62;
      const draw = () => { $("#rSteps", root).innerHTML = CS.steps("Job 8f21 · production", steps, pct < 100, "2:14"); };
      draw();
      CS.every(() => {
        pct = Math.min(100, pct + 3);
        $("#rBar", root).style.width = pct + "%"; $("#rPct", root).textContent = pct + "%";
        steps[2].state = pct + "%";
        if (pct >= 100) { steps[2].st = "done"; steps[2].state = "56s"; steps[3].st = "run"; steps[3].state = "12%"; $("#rLabel", root).textContent = "Shot 3 of 3 — logo end card"; pct = 12; $("#rSpend", root).textContent = "$2.40 of about $2.40"; }
        draw();
      }, 900);
      $("#rCancel", root).onclick = () => CS.modal({
        title: "Cancel this render?",
        body: `<p>Shot 1 is finished and stays in the project. Shot 2 is 62% through — that work is lost and <b>you are still charged $0.80 for it</b>, because the engine has already done it.</p><div class="note info" style="margin-top:10px">${ic("check")}<div>Nothing else is charged, and the storyboard is kept exactly as it is.</div></div>`,
        footer: `<button class="btn" data-close type="button">Keep rendering</button><button class="btn danger" data-close type="button">Cancel the render</button>`,
      });
    },
  });

  /* =============== 12. FINAL RESULT =============== */
  R("result", {
    icon: "play", nav: "Finished ad", title: "Your commercial is ready",
    crumb: ["Creative Studio", "AI support commercial", "Finished"],
    desc: "15 seconds, made from a sentence, in four and a half minutes.",
    actions: `<button class="btn" type="button" data-go="timeline">${ic("film", "sm")}Edit it</button><button class="btn primary" type="button" data-go="export">${ic("download", "sm")}Download</button>`,
    render() {
      return `<div class="grid g2" style="align-items:start"><div>
        ${CS.player("office", 3, { dur: "0:15", cap: 'Your phones never sleep. <em>Neither do we.</em>' })}
        <div class="row wrap" style="margin-top:10px"><span class="pill ok">1080p · 15s</span><span class="pill nub">${ic("cc", "sm")}Captions burned in</span><span class="pill nub">${ic("mic", "sm")}Voiceover: Rachel</span><span class="pill nub">${ic("dollar", "sm")}$3.29 all in</span><span class="pill nub">${ic("clock", "sm")}4 min 39s</span></div>
        <div class="card" style="margin-top:14px"><div class="card-h"><h3>Made for each place you post</h3></div>
          <div class="row wrap" style="gap:12px">${[["WhatsApp Status", "9:16", "v"], ["YouTube", "16:9", ""], ["Instagram post", "4:5", "p45"], ["Square", "1:1", "sq"]].map(([n, r, cls], i) => `
            <div style="width:130px"><div class="thumb ${cls}">${art("office", 3)}</div><b style="font-size:12.5px;display:block;margin-top:6px">${n}</b><span class="help">${r}</span></div>`).join("")}</div></div></div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>How was it?</h3><span class="sub">This is what teaches it</span></div>
            <div class="row wrap"><button class="btn" type="button" data-f="up">${ic("thumbup", "sm")}Good</button><button class="btn" type="button" data-f="down">${ic("thumbdown", "sm")}Not right</button></div>
            <div id="fbWhy" hidden style="margin-top:10px"><div class="seclbl">What was wrong?</div><div class="chips">${["Too slow", "Too fast", "Wrong feeling", "People look fake", "Logo too big", "Type too big", "Music doesn't fit", "Not on brand"].map((t) => `<button class="chip" type="button">${t}</button>`).join("")}</div>
              <div class="row" style="margin-top:10px"><button class="btn primary sm" type="button" id="fbSend">Send</button><span class="help">Used to make the next one better for you.</span></div></div>
            <div id="fbDone" hidden class="note ok" style="margin-top:10px">${ic("brain")}<div>Noted. Next time it will keep the camera slower and the mark small without being asked.</div></div></div>
          <div class="card"><div class="card-h"><h3>What it cost</h3></div>
            <div class="twrap"><table class="t"><tbody>
              ${[["3 production shots (15s)", "$2.40"], ["1 re-render after a failed check", "$0.80"], ["Voiceover — 19 words", "$0.05"], ["Music bed — 15s", "$0.04"], ["Joining, captions, 2 exports", "included"]].map(([a, b]) => `<tr><td>${a}</td><td class="r">${b}</td></tr>`).join("")}
              <tr><td><b>Total</b></td><td class="r"><b>$3.29</b></td></tr></tbody></table></div>
            <p class="help" style="margin-top:8px">41 of your 120 monthly video seconds used.</p></div>
          <div class="card"><div class="card-h"><h3>Do more with it</h3></div><div class="stack" style="gap:6px">
            ${[["Make a 30-second cut", "film"], ["Make a still for the website", "image"], ["Translate the voiceover to Yiddish", "globe"], ["Make 3 more like this", "copy"]].map(([t, i]) => `<button class="chip" type="button" style="justify-content:flex-start" data-go="coworker">${ic(i, "sm")}${t}</button>`).join("")}</div></div>
        </div></div>`;
    },
    init(root) {
      $$("[data-f]", root).forEach((b) => (b.onclick = () => { if (b.dataset.f === "down") { $("#fbWhy", root).hidden = false; } else { $("#fbDone", root).hidden = false; CS.toast("Thanks — noted as a good one", "brain"); } }));
      const s = $("#fbSend", root); if (s) s.onclick = () => { $("#fbWhy", root).hidden = true; $("#fbDone", root).hidden = false; };
    },
  });

  /* =============== 13. MOBILE =============== */
  R("mobile", {
    icon: "smartphone", nav: "Narrow layout", title: "On a phone",
    crumb: ["Creative Studio", "Narrow layout"],
    desc: "The studio is for looking, asking and approving on a phone. The heavy editors stay on a computer, and say so rather than showing a broken canvas.",
    render() {
      return `<div class="phones">
        <div class="phoneframe"><div class="phonebar"><span>9:41</span><span>${ic("activity", "sm")}</span></div>
          <div class="phonebody"><div class="row"><b style="font-size:16px">Creative Studio</b><button class="iconbtn" style="margin-left:auto">${ic("search")}</button></div>
            <div class="tiles" style="grid-template-columns:1fr 1fr">${KINDS.slice(0, 4).map(([n, i]) => `<div class="tile" style="min-height:84px"><span class="ti">${ic(i, "sm")}</span><b style="font-size:12.5px">${n}</b></div>`).join("")}</div>
            <div class="seclbl" style="margin-top:6px">Carry on</div>
            ${[["AI support commercial", "office", 3, "In review"], ["Spring promo", "product", 7, "Draft"]].map(([t, sc, sd, st]) => `<div class="row"><div class="thumb" style="width:74px;flex:none">${art(sc, sd)}</div><div><b style="font-size:13px">${t}</b><div class="help">${st}</div></div></div>`).join("")}
            <button class="btn primary" style="justify-content:center;margin-top:6px">${ic("loop", "sm")}Ask the Coworker</button></div>
          <div class="phonetabs">${["home", "folder", "loop", "layers", "gear"].map((i, k) => `<span style="${k === 0 ? "color:var(--accent)" : ""}">${ic(i)}</span>`).join("")}</div></div>

        <div class="phoneframe"><div class="phonebar"><span>9:43</span><span>${ic("activity", "sm")}</span></div>
          <div class="phonebody" style="gap:12px"><div class="row"><span class="avatar cw">${ic("loop", "sm")}</span><b style="font-size:14px">Coworker</b><span class="pill warn nub" style="margin-left:auto">Working</span></div>
            <div class="msg-user" style="max-width:100%">Make me a 15-second ad about AI support</div>
            ${CS.steps("Rendering", [{ tool: "Video", icon: "video", label: "Shot 1", state: "done", media: true }, { tool: "Video", icon: "video", label: "Shot 2", state: "62%", st: "run", media: true }, { tool: "Video", icon: "video", label: "Shot 3", state: "waiting", st: "todo", media: true }], true, "2:14")}
            <div class="approve"><div class="approve-h">${ic("alert", "sm")}Needs your OK</div><p style="font-size:13px">Render 15 seconds — about $2.40.</p><div class="row"><button class="btn primary sm">Render it</button><button class="btn sm">Not now</button></div></div>
            <div class="cwbox"><span class="faint" style="font-size:13px">Reply…</span></div></div></div>

        <div class="phoneframe"><div class="phonebar"><span>9:48</span><span>${ic("activity", "sm")}</span></div>
          <div class="phonebody"><div class="player" style="aspect-ratio:9/16">${art("office", 3, 'data-anim="1"')}<div class="capline" style="bottom:70px;font-size:13px">Your phones never sleep.</div></div>
            <div class="row wrap"><span class="pill ok">Ready</span><span class="pill nub">0:15</span><span class="pill nub">$3.29</span></div>
            <div class="row"><button class="btn primary" style="flex:1;justify-content:center">${ic("download", "sm")}Save</button><button class="btn" style="flex:1;justify-content:center">${ic("send", "sm")}Share</button></div>
            <div class="note info" style="font-size:12px">${ic("layout", "sm")}<div>The design and video editors need a bigger screen. Open this project on a computer to edit it — or just tell the Coworker what to change.</div></div>
            <button class="chip" style="justify-content:flex-start">${ic("loop", "sm")}“Make the logo smaller”</button></div></div>
      </div>`;
    },
  });

  /* =============== 14. UI STATES =============== */
  R("states", {
    icon: "list", nav: "Every other state", title: "The states nobody mocks up",
    crumb: ["Creative Studio", "States"],
    desc: "Empty, loading, failing, out of quota, cancelled. These decide whether the studio feels solid, so they are drawn here too.",
    render() {
      const S = [
        ["Empty — no projects yet", "ok", `<div class="empty" style="padding:20px"><span class="faint">${ic("folder", "xl")}</span><h3 style="font-size:15px">Nothing here yet</h3><p style="font-size:12.5px">Make your first image, video or design — or ask the Coworker for one.</p><button class="btn primary sm" type="button">${ic("plus", "sm")}New project</button></div>`],
        ["First run — no brand kit", "info", `<div class="note info">${ic("palette")}<div><b>Add your logo and colours first.</b> Everything will come out on-brand from then on.</div></div><button class="btn primary sm" type="button" data-go="brand">Set up the brand kit</button><p class="help">You can skip this — it will use plain Loopcom styling until you do.</p>`],
        ["Loading", "", `<div class="row"><div class="skel" style="width:74px;height:42px"></div><div style="flex:1"><div class="skel" style="height:11px;width:60%"></div><div class="skel" style="height:9px;width:35%;margin-top:6px"></div></div></div><div class="row"><div class="skel" style="width:74px;height:42px"></div><div style="flex:1"><div class="skel" style="height:11px;width:75%"></div><div class="skel" style="height:9px;width:45%;margin-top:6px"></div></div></div>`],
        ["Generating", "warn", `<div class="row"><span class="spin"></span><b style="font-size:13px">Making 4 images</b><span class="num muted" style="margin-left:auto">48%</span></div><div class="bar"><i style="width:48%"></i></div><div class="row wrap"><span class="help">About 20 seconds left</span><button class="btn sm" style="margin-left:auto" type="button">Cancel</button></div>`],
        ["Failed", "bad", `<div class="note bad">${ic("alert")}<div><b>Shot 2 didn't come out.</b> The engine returned a broken frame twice. Nothing was charged for the second try.</div></div><div class="row wrap"><button class="btn primary sm" type="button">${ic("refresh", "sm")}Try again</button><button class="btn sm" type="button">Try a different engine</button><button class="btn sm ghost" type="button">Show the details</button></div>`],
        ["Retrying by itself", "warn", `<div class="note warn">${ic("refresh")}<div><b>Re-doing shot 2 (try 2 of 3).</b> The first result failed our own check — a warped hand. You are not charged for a failed check.</div></div><div class="bar warn"><i style="width:30%"></i></div>`],
        ["No worker free", "warn", `<div class="note warn">${ic("server")}<div><b>All render machines are busy.</b> You are number 3 in the queue — about 6 minutes. The job is saved and will start by itself.</div></div><div class="row wrap"><button class="btn sm" type="button">${ic("bell", "sm")}Tell me when it starts</button><button class="btn sm" type="button">Use a faster engine instead</button></div>`],
        ["An engine is down", "bad", `<div class="note bad">${ic("ban")}<div><b>The production video engine isn't answering.</b> Drafts and images still work.</div></div><div class="row wrap"><button class="btn primary sm" type="button">Render a draft instead</button><button class="btn sm" type="button">${ic("bell", "sm")}Tell me when it's back</button></div><p class="help">Your admin has been told automatically.</p>`],
        ["Out of allowance", "warn", `<div class="note warn">${ic("gauge")}<div><b>You've used your 120 video seconds this month.</b> Images and designs still work, and it resets on the 1st.</div></div><div class="row wrap"><button class="btn primary sm" type="button">Ask for more</button><button class="btn sm" type="button">See what used it</button></div>`],
        ["Not allowed", "", `<div class="note">${ic("lock")}<div><b>You can make images, but not video.</b> Ask an admin at your company to turn video on for you.</div></div><button class="btn sm" type="button">${ic("send", "sm")}Ask for access</button>`],
        ["Cancelled", "", `<div class="note">${ic("x")}<div><b>Render cancelled.</b> Shot 1 is finished and saved. Shot 2 was 62% through and was charged ($0.80). Nothing else was.</div></div><button class="btn sm" type="button">${ic("refresh", "sm")}Start it again</button>`],
        ["Finished", "ok", `<div class="note ok">${ic("check")}<div><b>Your commercial is ready</b> — 15 seconds, $3.29, 4 min 39s.</div></div><div class="row wrap"><button class="btn primary sm" type="button" data-go="result">Watch it</button><button class="btn sm" type="button" data-go="export">${ic("download", "sm")}Download</button></div>`],
      ];
      return `<div class="states">${S.map(([t, k, b]) => `<div class="statecard"><div class="sh">${k === "ok" ? `<span class="ok-ic">${ic("check", "sm")}</span>` : k === "bad" ? `<span class="bad-ic">${ic("alert", "sm")}</span>` : k === "warn" ? `<span class="warn-ic">${ic("alert", "sm")}</span>` : `<span class="faint">${ic("circle", "sm")}</span>`}${t}</div><div class="sbo">${b}</div></div>`).join("")}</div>`;
    },
  });
})();
