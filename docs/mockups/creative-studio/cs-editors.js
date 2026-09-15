/* The four editors: image generator, video generator, design editor (+ agent design mode),
   timeline editor and the voice/music/captions screen. Example data only. */
(function () {
  const { ic, esc, art, $, $$ } = CS;
  const R = (id, d) => CS.register(id, d);

  /* =============== IMAGE GENERATOR =============== */
  const IMG_MODES = [["Create", "wand"], ["Edit", "brush"], ["Inpaint", "eraser"], ["Expand", "expand"], ["Remove background", "crop"], ["Replace background", "image"], ["Upscale", "zoomin"], ["Variations", "copy"]];
  R("image", {
    icon: "image", nav: "Image generator", title: "Images",
    crumb: ["Creative Studio", "Images"],
    desc: "Type what you want, or hand it a picture to change. The Coworker can drive every one of these controls itself.",
    render() {
      return `<div class="genlay">
        <div class="gpanel">
          <div class="tabs" id="imMode" role="tablist">${IMG_MODES.map(([n, i], k) => `<button role="tab" type="button" aria-selected="${k === 0}" data-m="${n}">${ic(i, "sm")}${n}</button>`).join("")}</div>
          <div class="sect" id="imBody"></div>
          <details class="adv"><summary>${ic("sliders", "sm")}Advanced</summary><div class="body">
            <label class="fld">Engine<select class="select"><option>Choose for me (recommended)</option><option>Loopcom image · fast</option><option>Loopcom image · detailed</option><option>Loopcom image · text-in-picture</option><option>External · premium</option></select><span class="help">Your admin decides which of these you may use.</span></label>
            <div class="grid g2" style="gap:8px"><label class="fld">Seed<input class="input mono" value="418823"></label><label class="fld">How closely to follow<input class="range" type="range" min="1" max="10" value="7"></label></div>
            <label class="fld">Things to avoid<input class="input" value="warped hands, extra fingers, text artefacts, watermarks"></label>
            <div class="row"><div style="flex:1"><b style="font-size:13px">Transparent background</b><div class="help">Only some engines can</div></div>${CS.sw(false, "Transparent background")}</div>
          </div></details>
          <div class="cost"><div><b id="imCost">4 images · about $0.17</b><div class="help">≈ 12 seconds</div></div>
            <button class="btn primary" type="button" id="imGo" style="margin-left:auto">${ic("spark", "sm")}Make them</button></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3 id="imTitle">Results</h3><span class="sub" id="imSub">Click one to keep working on it</span>
            <span class="end"><button class="btn sm" type="button">${ic("layers", "sm")}Send to library</button><button class="btn sm" type="button" data-go="design">${ic("layout", "sm")}Open in design editor</button></span></div>
            <div class="resgrid" id="imRes"></div></div>
          <div class="card" id="imDetail"></div>
        </div></div>`;
    },
    init(root) {
      const body = $("#imBody", root), res = $("#imRes", root), detail = $("#imDetail", root);
      const ref = (label, scene, seed) => `<div class="drop"><div class="th">${art(scene, seed)}</div><div style="flex:1"><b style="font-size:12.5px">${label}</b><div class="help">desk-phone-front.png · 2.1 MB</div></div><button class="iconbtn" aria-label="Remove">${ic("x", "sm")}</button></div>`;
      const common = `<div class="sect"><div class="seclbl">Shape</div><div class="chips" data-single>${["1:1", "4:5", "16:9", "9:16", "3:2", "Custom"].map((r, i) => `<button class="chip ${i === 1 ? "on" : ""}" type="button">${r}</button>`).join("")}</div></div>
        <div class="sect"><div class="seclbl">Look</div><div class="chips" data-single>${["On brand", "Photographic", "Cinematic", "Product studio", "Illustration", "Flat graphic"].map((r, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${r}</button>`).join("")}</div>
          <span class="chip nub" style="justify-content:flex-start">${ic("palette", "sm")}Loopcom brand kit is on — colours and fonts come from it</span></div>
        <div class="sect"><div class="seclbl">How many</div><div class="chips" data-single>${["1", "2", "4", "8"].map((r, i) => `<button class="chip ${i === 2 ? "on" : ""}" type="button">${r}</button>`).join("")}</div></div>`;
      const BODIES = {
        Create: () => `<label class="fld">What do you want?<textarea class="input" rows="4">Our T54W desk phone on a clean desk in a small shop, morning light through the window, shallow depth of field, room for a headline on the left.</textarea></label>
          ${ref("Style reference (optional)", "office", 3)}${common}`,
        Edit: () => `${ref("Picture to change", "product", 7)}<label class="fld">What should change?<textarea class="input" rows="3">Make the desk wood warmer and add a soft shadow under the phone. Keep the phone exactly as it is.</textarea></label>${common}`,
        Inpaint: () => `${ref("Picture", "product", 7)}<div class="note info">${ic("brush")}<div>Paint over the part you want replaced on the picture to the right, then say what goes there.</div></div>
          <label class="fld">Put this there<input class="input" value="a plain white mug, slightly out of focus"></label>
          <div class="row"><span class="help">Brush</span><input class="range" type="range" min="10" max="80" value="34" id="imBrush"><button class="btn sm" type="button" id="imClear">Clear</button></div>`,
        Expand: () => `${ref("Picture", "product", 7)}<div class="sect"><div class="seclbl">Make it wider or taller</div><div class="chips" data-single>${["16:9", "9:16", "1:1", "4:5"].map((r, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${r}</button>`).join("")}</div>
          <p class="help">The studio invents the new edges and matches the light.</p></div>`,
        "Remove background": () => `${ref("Picture", "product", 7)}<div class="note info">${ic("crop")}<div>Cuts the subject out and saves a transparent PNG. Runs on our own machines, and costs nothing.</div></div>
          <div class="row"><div style="flex:1"><b style="font-size:13px">Keep a soft edge</b><div class="help">Better for hair and glass</div></div>${CS.sw(true, "Keep a soft edge")}</div>`,
        "Replace background": () => `${ref("Picture", "product", 7)}<label class="fld">New background<textarea class="input" rows="3">A dark studio backdrop with a soft blue rim light, matching our brand blue.</textarea></label>
          <div class="row"><div style="flex:1"><b style="font-size:13px">Match the light on the subject</b></div>${CS.sw(true, "Match the light")}</div>${common}`,
        Upscale: () => `${ref("Picture", "product", 7)}<div class="sect"><div class="seclbl">How much bigger</div><div class="chips" data-single>${["2×", "4×"].map((r, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${r}</button>`).join("")}</div>
          <div class="kv" style="margin-top:8px"><dt>Now</dt><dd>1024 × 1280</dd><dt>After</dt><dd>2048 × 2560</dd></div></div>`,
        Variations: () => `${ref("Picture", "product", 7)}<div class="sect"><div class="seclbl">How different</div><input class="range" type="range" min="1" max="10" value="4"><div class="row"><span class="help">Nearly the same</span><span class="help" style="margin-left:auto">Loosely inspired</span></div></div>${common}`,
      };
      const RES = { Create: [["product", 7], ["product", 12], ["product", 18], ["office", 21]], Variations: [["product", 7], ["product", 31], ["product", 42], ["product", 55]] };
      function results(mode) {
        const list = RES[mode] || [["product", 7], ["product", 12]];
        res.innerHTML = list.map(([sc, sd], i) => `<div class="res ${i === 0 ? "on" : ""}" data-i="${i}">${art(sc, sd)}<div class="ov">
          <button type="button">${ic("star", "sm")}Keep</button><button type="button">${ic("copy", "sm")}More like this</button><button type="button">${ic("zoomin", "sm")}Bigger</button><button type="button">${ic("download", "sm")}</button></div></div>`).join("");
        CS.hydrate(res);
        $$(".res", res).forEach((r) => (r.onclick = () => { $$(".res", res).forEach((x) => x.classList.remove("on")); r.classList.add("on"); }));
      }
      function showDetail(mode) {
        if (mode === "Inpaint") {
          detail.innerHTML = `<div class="card-h"><h3>Paint over what should change</h3><span class="sub">Drag on the picture</span></div>
            <div class="stage" style="padding:10px"><div style="position:relative;width:min(100%,460px)"><div class="thumb sq" style="border-radius:8px">${art("product", 7)}</div>
            <canvas id="maskCv" style="position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;border-radius:8px"></canvas></div></div>
            <div class="row wrap" style="margin-top:10px"><span class="pill info nub">${ic("brush", "sm")}Mask: 4% of the picture</span><button class="btn sm" type="button" id="imClear2">Clear</button><span class="help">The rest of the picture is untouched, pixel for pixel.</span></div>`;
          CS.hydrate(detail);
          const cv = $("#maskCv", detail); const rect = () => cv.getBoundingClientRect();
          const fit = () => { const r = rect(); cv.width = r.width * 2; cv.height = r.height * 2; };
          CS.later(fit, 30);
          let down = false; const ctx = cv.getContext("2d");
          const paint = (e) => { const r = rect(); ctx.fillStyle = "rgba(34,168,255,.55)"; ctx.beginPath(); ctx.arc((e.clientX - r.left) * 2, (e.clientY - r.top) * 2, 34, 0, 7); ctx.fill(); };
          cv.addEventListener("pointerdown", (e) => { down = true; cv.setPointerCapture(e.pointerId); paint(e); });
          cv.addEventListener("pointermove", (e) => down && paint(e));
          cv.addEventListener("pointerup", () => (down = false));
          const c = $("#imClear2", detail); c.onclick = () => ctx.clearRect(0, 0, cv.width, cv.height);
        } else if (mode === "Remove background") {
          detail.innerHTML = `<div class="card-h"><h3>Before and after</h3></div><div class="grid g2"><div><div class="thumb sq">${art("product", 7)}</div><div class="help" style="margin-top:5px">Original</div></div>
            <div><div class="thumb sq" style="background:repeating-conic-gradient(#d7dde6 0 25%, #eef1f5 0 50%) 0 0/18px 18px">${art("product", 8)}</div><div class="help" style="margin-top:5px">Cut out · transparent PNG</div></div></div>`;
          CS.hydrate(detail);
        } else {
          detail.innerHTML = `<div class="card-h"><h3>The one you picked</h3><span class="end"><span class="pill nub mono">seed 418823</span></span></div>
            <div class="grid g2" style="align-items:start"><div class="thumb p45">${art("product", 7)}</div>
            <div class="stack"><div class="kv"><dt>Engine</dt><dd>Loopcom image · detailed</dd><dt>Size</dt><dd>1024 × 1280</dd><dt>Took</dt><dd>7.4s</dd><dt>Cost</dt><dd>$0.04</dd></div>
            <div class="row wrap"><button class="btn sm">${ic("brush", "sm")}Edit</button><button class="btn sm">${ic("eraser", "sm")}Inpaint</button><button class="btn sm">${ic("expand", "sm")}Expand</button><button class="btn sm">${ic("crop", "sm")}Cut out</button><button class="btn sm">${ic("zoomin", "sm")}Upscale</button></div>
            <div class="note ok">${ic("check")}<div>Checked automatically: hands, faces, the logo and any text in the picture all came out right.</div></div></div></div>`;
          CS.hydrate(detail);
        }
      }
      function setMode(mode) { body.innerHTML = BODIES[mode] ? BODIES[mode]() : BODIES.Create(); CS.hydrate(body); CS.wireSwitches(body); CS.wireChips(body); results(mode); showDetail(mode); }
      $$("#imMode button", root).forEach((b) => b.addEventListener("click", () => { $$("#imMode button", root).forEach((x) => x.setAttribute("aria-selected", x === b)); setMode(b.dataset.m); }));
      setMode("Create");
      $("#imGo", root).onclick = () => {
        res.innerHTML = Array.from({ length: 4 }, () => `<div class="res"><div class="skel" style="aspect-ratio:4/5"></div></div>`).join("");
        $("#imSub", root).innerHTML = `<span class="spin" style="display:inline-block;vertical-align:-3px"></span> Making 4 images…`;
        CS.later(() => { results($("#imMode button[aria-selected='true']", root).dataset.m); $("#imSub", root).textContent = "Click one to keep working on it"; CS.toast("4 images · $0.17", "check"); }, 1600);
      };
    },
  });

  /* =============== VIDEO GENERATOR =============== */
  const ENGINES = [
    { id: "auto", n: "Choose for me", max: 15, native: "varies", lf: true, ext: true, note: "Picks on quality, speed and cost from the engines your admin allows." },
    { id: "prod", n: "Loopcom video · production", max: 15, native: "up to 16s", lf: false, ext: true, note: "Best quality. Native audio available." },
    { id: "fast", n: "Loopcom video · fast", max: 10, native: "5–10s", lf: true, ext: false, note: "Quick and cheap. Good for judging an idea." },
    { id: "own", n: "On our own machines", max: 15, native: "5s native", lf: true, ext: true, note: "Private — nothing leaves Loopcom. Longer waits. Loopcom joins 5s pieces to reach 15s." },
  ];
  R("video", {
    icon: "video", nav: "Video generator", title: "Video",
    crumb: ["Creative Studio", "Video"],
    desc: "One clip is 15 seconds at most. Draft is quick and rough for judging an idea; Production is the real thing.",
    render() {
      return `<div class="genlay">
        <div class="gpanel">
          <div class="sect"><div class="seg" style="width:100%" id="vMode"><button type="button" aria-pressed="true" data-v="draft" style="flex:1">Draft · 5–8s</button><button type="button" aria-pressed="false" data-v="prod" style="flex:1">Production · up to 15s</button></div>
            <p class="help" id="vModeNote">Quick and cheap, so you can judge the idea before spending on the real render.</p></div>
          <div class="tabs" id="vSrc" role="tablist"><button role="tab" type="button" aria-selected="true">${ic("type", "sm")}From words</button><button role="tab" type="button" aria-selected="false">${ic("image", "sm")}From a picture</button></div>
          <label class="fld">What happens in the shot<textarea class="input" rows="4">A small shop floor at night. One desk phone lights up and rings. Slow push-in, practical light, shallow depth of field.</textarea></label>
          <div class="grid g2" style="gap:8px"><div class="drop" style="flex-direction:column;align-items:flex-start"><b style="font-size:12px">First frame</b><div class="th" style="width:100%;height:56px">${art("office", 3)}</div></div>
            <div class="drop" style="flex-direction:column;align-items:flex-start" id="vLast"><b style="font-size:12px">Last frame</b><div style="width:100%;height:56px;display:grid;place-items:center;border:1px dashed var(--border);border-radius:8px;color:var(--text-faint)">${ic("plus")}</div></div></div>
          <div class="sect"><div class="row"><span class="seclbl" style="margin:0">Length</span><span class="pill nub num" id="vDurV" style="margin-left:auto">8s</span></div>
            <input class="range" type="range" min="2" max="8" value="8" id="vDur"><p class="help" id="vDurNote">Draft mode caps at 8 seconds.</p></div>
          <div class="sect"><div class="seclbl">Shape and size</div><div class="chips" data-single>${["16:9", "9:16", "1:1", "4:5"].map((r, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${r}</button>`).join("")}</div>
            <div class="chips" data-single>${["720p", "1080p", "4K"].map((r, i) => `<button class="chip ${i === 1 ? "on" : ""}" type="button">${r}</button>`).join("")}</div></div>
          <div class="sect"><div class="seclbl">Camera</div><div class="chips" data-single>${["Locked off", "Slow push-in", "Pull back", "Pan left", "Pan right", "Handheld", "Orbit"].map((r, i) => `<button class="chip ${i === 1 ? "on" : ""}" type="button">${r}</button>`).join("")}</div></div>
          <div class="sect"><div class="seclbl">Look</div><div class="chips" data-single>${["On brand", "Cinematic", "Documentary", "Product", "Graphic"].map((r, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${r}</button>`).join("")}</div>
            <div class="row"><span class="help">How much movement</span><input class="range" type="range" min="1" max="10" value="4" style="flex:1"></div></div>
          <details class="adv"><summary>${ic("sliders", "sm")}Advanced</summary><div class="body">
            <label class="fld">Engine<select class="select" id="vEngine">${ENGINES.map((e) => `<option value="${e.id}">${e.n}</option>`).join("")}</select><span class="help" id="vEngNote">${ENGINES[0].note}</span></label>
            <div class="grid g2" style="gap:8px"><label class="fld">Seed<input class="input mono" value="418823"></label><label class="fld">Keep the same<select class="select"><option>Spokesperson — “Malky”</option><option>Product — T54W</option><option>Nothing</option></select></label></div>
            <label class="fld">Things to avoid<input class="input" value="warped hands, flicker, on-screen text, extra logos"></label>
            <div class="row"><div style="flex:1"><b style="font-size:13px">Let it make sound</b><div class="help">Some engines generate room tone and effects</div></div>${CS.sw(false, "Generate sound")}</div>
          </div></details>
          <div class="cost"><div><b id="vCost">1 clip · about $0.30</b><div class="help" id="vTime">≈ 40 seconds</div></div><button class="btn primary" type="button" id="vGo" style="margin-left:auto">${ic("play", "sm")}Render</button></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>Preview</h3><span class="sub" id="vState">Last render · draft</span><span class="end"><button class="btn sm" type="button" data-go="storyboard">${ic("film", "sm")}Add to storyboard</button></span></div>
            <div id="vPlayer">${CS.player("office", 3, { dur: "0:08" })}</div>
            <div class="row wrap" style="margin-top:10px"><span class="pill nub mono">seed 418823</span><span class="pill nub">Draft · 8s · 1080p</span><button class="btn sm">${ic("refresh", "sm")}Again</button><button class="btn sm">${ic("copy", "sm")}Variation</button><button class="btn sm">${ic("expand", "sm")}Extend 5s</button></div></div>
          <div class="card"><div class="card-h"><h3>What each engine can actually do</h3><span class="sub">Loopcom hides the differences — this is what is underneath</span></div>
            <div class="twrap"><table class="t"><thead><tr><th>Engine</th><th>Longest clip</th><th>Native length</th><th>Last frame</th><th>Extend</th><th>Where it runs</th></tr></thead><tbody>
              ${[["Loopcom video · production", "15s", "up to 16s", "no", "yes", "External provider"], ["Loopcom video · fast", "10s", "5–10s", "yes", "no", "External provider"], ["On our own machines", "15s (joined)", "5s", "yes", "yes", "Loopcom GPU"]]
                .map(([a, b, c, d, e, f]) => `<tr><td><b>${a}</b></td><td>${b}</td><td class="muted">${c}</td><td>${d === "yes" ? `<span class="ok-ic">${ic("check", "sm")}</span>` : `<span class="faint">${ic("x", "sm")}</span>`}</td><td>${e === "yes" ? `<span class="ok-ic">${ic("check", "sm")}</span>` : `<span class="faint">${ic("x", "sm")}</span>`}</td><td class="muted">${f}</td></tr>`).join("")}
            </tbody></table></div>
            <div class="note info" style="margin-top:10px">${ic("film")}<div><b>Asking for 15 seconds always gives you 15 seconds.</b> If the engine underneath only makes 5, Loopcom renders three pieces that continue from each other and joins them — you never see the seam or the settings.</div></div></div>
        </div></div>`;
    },
    init(root) {
      const dur = $("#vDur", root), durV = $("#vDurV", root), cost = $("#vCost", root);
      const price = () => { const d = +dur.value, prod = $("#vMode button[aria-pressed='true']", root).dataset.v === "prod"; cost.textContent = `1 clip · about ${CS.money(d * (prod ? 0.16 : 0.04))}`; $("#vTime", root).textContent = `≈ ${prod ? 50 : 35} seconds`; durV.textContent = d + "s"; };
      dur.addEventListener("input", price);
      $$("#vMode button", root).forEach((b) => b.addEventListener("click", () => {
        $$("#vMode button", root).forEach((x) => x.setAttribute("aria-pressed", x === b));
        const prod = b.dataset.v === "prod";
        dur.max = prod ? 15 : 8; dur.value = prod ? 15 : 8;
        $("#vDurNote", root).textContent = prod ? "15 seconds is the most any single clip can be. Longer films are made of several shots." : "Draft mode caps at 8 seconds.";
        $("#vModeNote", root).textContent = prod ? "Full quality, up to 15 seconds, and it goes through every automatic check before you see it." : "Quick and cheap, so you can judge the idea before spending on the real render.";
        price();
      }));
      const eng = $("#vEngine", root);
      eng.addEventListener("change", () => {
        const e = ENGINES.find((x) => x.id === eng.value);
        $("#vEngNote", root).textContent = e.note;
        const last = $("#vLast", root);
        last.style.opacity = e.lf ? "1" : ".45";
        last.title = e.lf ? "" : "This engine cannot take a last frame";
        if (!e.lf && !last.querySelector(".pill")) last.insertAdjacentHTML("beforeend", `<span class="pill warn nub" style="margin-top:6px">Not supported by this engine</span>`);
        else if (e.lf) { const p = last.querySelector(".pill"); p && p.remove(); }
      });
      price();
      $("#vGo", root).onclick = () => {
        const p = $("#vPlayer", root);
        p.innerHTML = `<div class="player" style="aspect-ratio:16/9;display:grid;place-items:center;color:#cfe3f5"><div style="display:grid;gap:10px;justify-items:center;padding:20px;text-align:center"><span class="spin" style="width:22px;height:22px"></span><b id="vpct">Rendering… 8%</b><span class="help" style="color:#8fb6d8">Queued behind 1 job · about 50 seconds</span><button class="btn sm" type="button" id="vStop">Cancel</button></div></div>`;
        let n = 8; const t = CS.every(() => { n += 11; const el = $("#vpct", root); if (!el) return clearInterval(t); if (n >= 100) { clearInterval(t); p.innerHTML = CS.player("office", 23, { dur: "0:" + String(dur.value).padStart(2, "0") }); CS.hydrate(p); $("#vState", root).textContent = "Just rendered"; CS.toast("Clip ready", "check"); } else el.textContent = `Rendering… ${n}%`; }, 420);
      };
    },
  });

  /* =============== DESIGN EDITOR (shared doc model) =============== */
  function makeDoc() {
    return {
      rev: 12, w: 4, h: 5,
      objs: [
        { id: "bg", name: "Background photo", type: "img", scene: "office", seed: 3, x: 0, y: 0, w: 100, h: 100, locked: false },
        { id: "scrim", name: "Dark overlay", type: "rect", fill: "linear-gradient(180deg,rgba(4,10,18,.15),rgba(4,10,18,.88))", x: 0, y: 0, w: 100, h: 100 },
        { id: "eyebrow", name: "Eyebrow", type: "text", text: "LOOPCOM · AI TECHNICAL SUPPORT", x: 9, y: 58, w: 70, size: 2.1, weight: 700, color: "#8fd0ff", track: ".16em" },
        { id: "head", name: "Headline", type: "text", text: "Your phones never sleep.", x: 9, y: 63, w: 74, size: 8.6, weight: 700, color: "#ffffff", lh: 1.03 },
        { id: "sub", name: "Sub-line", type: "text", text: "Neither do we. Set up in a day, on the phones you already have.", x: 9, y: 79, w: 62, size: 3.1, weight: 500, color: "rgba(255,255,255,.82)", lh: 1.35 },
        { id: "cta", name: "Button", type: "btn", text: "Talk to us", x: 9, y: 87.5, w: 26, h: 6.4, size: 2.9 },
        { id: "logo", name: "Loopcom mark", type: "logo", x: 66, y: 87, w: 26 },
      ],
    };
  }
  function renderDoc(doc, host, sel) {
    host.innerHTML = doc.objs.map((o) => {
      const base = `left:${o.x}%;top:${o.y}%;${o.w != null ? `width:${o.w}%;` : ""}${o.h != null ? `height:${o.h}%;` : ""}`;
      const cls = `obj${sel === o.id ? " selected" : ""}`;
      if (o.type === "img") return `<div class="${cls}" data-id="${o.id}" style="${base}">${art(o.scene, o.seed)}</div>`;
      if (o.type === "rect") return `<div class="${cls}" data-id="${o.id}" style="${base}background:${o.fill}"></div>`;
      if (o.type === "logo") return `<div class="${cls}" data-id="${o.id}" style="${base}"><img src="brand/loopcom-nav-h64@2x.png" alt="" style="width:100%;display:block"></div>`;
      if (o.type === "btn") return `<div class="${cls}" data-id="${o.id}" style="${base}display:grid;place-items:center;border-radius:99px;background:linear-gradient(135deg,#22a8ff,#4f7bff);color:#fff;font-weight:700;font-size:${o.size}cqw">${esc(o.text)}</div>`;
      return `<div class="${cls}" data-id="${o.id}" style="${base}font-size:${o.size}cqw;font-weight:${o.weight};color:${o.color};line-height:${o.lh || 1.2};letter-spacing:${o.track || "0"};">${esc(o.text)}</div>`;
    }).join("");
    CS.hydrate(host);
  }
  function editorMarkup(id) {
    return `<div class="edtool">
      <button class="iconbtn" type="button" aria-label="Undo">${ic("undo")}</button><button class="iconbtn" type="button" aria-label="Redo">${ic("redo")}</button><span class="sep"></span>
      <select class="select" style="width:118px;min-height:30px">${["Inter", "Inter Tight", "Georgia"].map((f) => `<option>${f}</option>`).join("")}</select>
      <input class="input" style="width:58px;min-height:30px" value="86" aria-label="Font size" id="${id}Size">
      <button class="iconbtn" type="button" aria-label="Bold"><b style="font-size:13px">B</b></button><button class="iconbtn" type="button" aria-label="Align">${ic("alignc")}</button>
      <span class="sep"></span><button class="iconbtn" type="button" aria-label="Colour" style="color:#22a8ff">${ic("palette")}</button>
      <button class="iconbtn" type="button" aria-label="Opacity">${ic("eye")}</button><button class="iconbtn" type="button" aria-label="Shadow">${ic("layers")}</button>
      <span class="sep"></span><button class="iconbtn" type="button" aria-label="Bring forward">${ic("chev")}</button><button class="iconbtn" type="button" aria-label="Duplicate">${ic("copy")}</button>
      <button class="iconbtn" type="button" aria-label="Lock">${ic("lock")}</button><button class="iconbtn" type="button" aria-label="Delete">${ic("trash")}</button>
      <span class="sep"></span><span class="capchip">${ic("grid", "sm")}Snapping on</span><span class="capchip" id="${id}Rev">revision 12</span>
      <button class="btn primary sm" type="button" style="margin-left:auto">${ic("download", "sm")}Export</button></div>`;
  }
  const PANEL_TABS = [["Templates", "template"], ["Text", "type"], ["Photos", "image"], ["Elements", "shapes"], ["Uploads", "upload"], ["Brand", "palette"], ["Layers", "layers"]];

  R("design", {
    icon: "layout", nav: "Design editor", title: "Design editor",
    crumb: ["Creative Studio", "Spring desk-phone promo", "Design"],
    desc: "A full canvas editor — text, photos, shapes, layers, alignment, brand assets. Everything here is also an instruction the Coworker can carry out, so you and it are never editing different copies.",
    render() {
      return `<div class="edlay">
        <div class="edpanel"><div class="tabs" id="dTabs" style="flex-wrap:wrap">${PANEL_TABS.map(([n, i], k) => `<button type="button" role="tab" aria-selected="${k === 5}" title="${n}">${ic(i, "sm")}</button>`).join("")}</div><div id="dPanel"></div></div>
        <div><div id="dTool"></div><div class="canvaswrap"><div class="dcanvas" id="dCanvas" style="container-type:inline-size"></div></div>
          <div class="row wrap" style="margin-top:10px"><span class="capchip">1080 × 1350 · 4:5</span><span class="capchip">${ic("layers", "sm")}7 layers</span><span class="capchip" id="dSel">Nothing selected</span>
            <button class="btn sm" style="margin-left:auto" type="button" data-go="agentdesign">${ic("loop", "sm")}Let the Coworker change it</button></div></div>
        <div class="edpanel"><div class="seclbl" style="margin:0">Selected</div><div id="dProps"><p class="help">Click something on the canvas.</p></div>
          <div class="divider"></div><div class="seclbl" style="margin:0">Layers</div><div id="dLayers"></div></div></div>`;
    },
    init(root) { mountEditor(root, "d", false); },
  });

  R("agentdesign", {
    icon: "loop", nav: "Coworker designing", title: "The Coworker designing",
    crumb: ["Creative Studio", "Spring desk-phone promo", "Coworker"],
    desc: "Say what's wrong in plain English. It looks at the design as it is right now — including anything you just moved by hand — changes it, and tells you what it did.",
    render() {
      return `<div class="edlay" style="grid-template-columns:minmax(0,1fr) 330px">
        <div><div id="aTool"></div><div class="canvaswrap"><div class="dcanvas" id="aCanvas" style="container-type:inline-size"></div></div>
          <div class="row wrap" style="margin-top:10px"><span class="capchip" id="aSel">Nothing selected</span><span class="capchip">${ic("grip", "sm")}Drag anything — the Coworker sees where you left it</span>
            <button class="btn sm" style="margin-left:auto" type="button" data-go="design">${ic("layout", "sm")}Full editor</button></div>
          <div class="card" style="margin-top:12px"><div class="card-h"><h3>What it did to this design</h3><span class="sub">Same list the version history keeps</span></div><div class="oplog" id="aLog"><div class="faint">Nothing yet.</div></div></div></div>
        <div class="stack">
          <div class="cwchat" style="min-height:0"><div class="head"><span class="avatar cw">${ic("loop", "sm")}</span><div style="flex:1"><b>Coworker</b><div class="faint" style="font-size:12px" id="aStatus">Looking at this design</div></div></div>
            <div class="msgs" id="aMsgs" style="max-height:44vh"></div>
            <div class="comp"><div class="stack" style="gap:6px" id="aAsks">
              <button class="chip" type="button" data-ask="expensive" style="justify-content:flex-start;text-align:left">Make this look more expensive and professional. The heading is too big and I don't like that background.</button>
              <button class="chip" type="button" data-ask="logo" style="justify-content:flex-start">Move the logo to the bottom.</button>
              <button class="chip" type="button" data-ask="align" style="justify-content:flex-start">Now make it slightly smaller and line it up with the text.</button>
            </div><p class="help" style="text-align:center;margin-top:8px">Try them in order — move the logo yourself in between.</p></div></div>
          <div class="card"><div class="card-h"><h3>How it stays in step with you</h3></div>
            <ol class="steps-ol" style="font-size:12.5px"><li>It reads the design as it is right now, not a copy it remembers.</li><li>It writes its changes against that exact revision number.</li><li>If you changed something in the same moment, its change is refused and it reads the design again before trying.</li><li>Everything it does is an ordinary edit — you can undo it, or drag it somewhere else afterwards.</li></ol></div>
        </div></div>`;
    },
    init(root) { mountEditor(root, "a", true); },
  });

  function mountEditor(root, p, agent) {
    const doc = makeDoc();
    const canvas = $(`#${p}Canvas`, root);
    const toolHost = $(`#${p}Tool`, root); if (toolHost) toolHost.innerHTML = editorMarkup(p);
    let sel = null;
    const rev = () => { const r = $(`#${p}Rev`, root); if (r) r.textContent = "revision " + doc.rev; };
    function draw() {
      renderDoc(doc, canvas, sel);
      $$(".obj", canvas).forEach((el) => {
        el.addEventListener("pointerdown", (e) => {
          sel = el.dataset.id; paintSel(); drag(e, el);
        });
      });
      paintSel();
    }
    function paintSel() {
      $$(".obj", canvas).forEach((el) => el.classList.toggle("selected", el.dataset.id === sel));
      const o = doc.objs.find((x) => x.id === sel);
      const label = $(`#${p}Sel`, root); if (label) label.textContent = o ? `${o.name} · x ${o.x.toFixed(1)}% y ${o.y.toFixed(1)}%` : "Nothing selected";
      const props = $("#dProps", root);
      if (props) props.innerHTML = o ? `<div class="stack" style="gap:8px">
          <div class="row"><span class="lt dot-scope">${ic(o.type === "text" ? "type" : o.type === "img" ? "image" : o.type === "logo" ? "spark" : "square", "sm")}</span><b style="font-size:13px">${o.name}</b></div>
          ${o.type === "text" ? `<label class="fld">Words<textarea class="input" rows="2" id="dText">${esc(o.text)}</textarea></label>
            <div class="grid g2" style="gap:8px"><label class="fld">Size<input class="input" type="number" step="0.2" value="${o.size}" id="dSize2"></label><label class="fld">Weight<select class="select"><option ${o.weight === 700 ? "selected" : ""}>700</option><option ${o.weight === 500 ? "selected" : ""}>500</option><option>400</option></select></label></div>` : ""}
          <div class="grid g2" style="gap:8px"><label class="fld">X<input class="input" type="number" value="${o.x.toFixed(1)}" id="dX"></label><label class="fld">Y<input class="input" type="number" value="${o.y.toFixed(1)}" id="dY"></label></div>
          ${o.w != null ? `<label class="fld">Width<input class="input" type="number" value="${o.w.toFixed(1)}" id="dW"></label>` : ""}
          <label class="fld">Opacity<input class="range" type="range" min="0" max="100" value="100"></label>
          <div class="row wrap"><button class="btn sm" type="button">${ic("copy", "sm")}Duplicate</button><button class="btn sm" type="button">${ic("lock", "sm")}Lock</button><button class="btn sm danger" type="button">${ic("trash", "sm")}</button></div></div>` : `<p class="help">Click something on the canvas.</p>`;
      if (props && o) {
        const bind = (id, key) => { const el = $("#" + id, props); if (el) el.addEventListener("input", () => { o[key] = key === "text" ? el.value : +el.value; doc.rev++; rev(); draw(); }); };
        bind("dText", "text"); bind("dSize2", "size"); bind("dX", "x"); bind("dY", "y"); bind("dW", "w");
      }
      const layers = $("#dLayers", root);
      if (layers) {
        layers.innerHTML = doc.objs.slice().reverse().map((o2) => `<div class="layer ${o2.id === sel ? "on" : ""}" data-id="${o2.id}"><span class="lt">${ic(o2.type === "text" ? "type" : o2.type === "img" ? "image" : o2.type === "logo" ? "spark" : o2.type === "btn" ? "square" : "square", "sm")}</span><span>${o2.name}</span><button class="iconbtn" type="button" aria-label="Hide">${ic("eye", "sm")}</button></div>`).join("");
        $$(".layer", layers).forEach((l) => (l.onclick = () => { sel = l.dataset.id; paintSel(); }));
      }
    }
    function drag(e, el) {
      const o = doc.objs.find((x) => x.id === el.dataset.id); if (!o || o.locked) return;
      const box = canvas.getBoundingClientRect(); const sx = e.clientX, sy = e.clientY, ox = o.x, oy = o.y;
      el.setPointerCapture(e.pointerId);
      const move = (ev) => { o.x = Math.max(-5, Math.min(100, ox + ((ev.clientX - sx) / box.width) * 100)); o.y = Math.max(-5, Math.min(100, oy + ((ev.clientY - sy) / box.height) * 100)); const node = $(`.obj[data-id="${o.id}"]`, canvas); node.style.left = o.x + "%"; node.style.top = o.y + "%"; const lbl = $(`#${p}Sel`, root); if (lbl) lbl.textContent = `${o.name} · x ${o.x.toFixed(1)}% y ${o.y.toFixed(1)}%`; };
      const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); doc.rev++; rev(); if (agent) log(`<b>you moved</b> ${o.name} → x ${o.x.toFixed(1)}% y ${o.y.toFixed(1)}%  (revision ${doc.rev})`); };
      el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
    }
    function log(html) { const l = $("#aLog", root); if (!l) return; if (l.querySelector(".faint")) l.innerHTML = ""; l.insertAdjacentHTML("beforeend", `<div>${html}</div>`); l.scrollTop = l.scrollHeight; }
    draw(); rev();

    if (!agent) {
      const panel = $("#dPanel", root);
      const PANELS = {
        Brand: `<div class="stack" style="gap:8px"><div class="seclbl" style="margin:0">Loopcom — Signal Core</div>
          <div class="row wrap" style="gap:6px">${["#22A8FF", "#4F7BFF", "#0C1218", "#141F2B", "#F6F8FB"].map((c) => `<span style="width:30px;height:30px;border-radius:8px;background:${c};border:1px solid var(--border)" title="${c}"></span>`).join("")}</div>
          <div style="background:#0c1218;border-radius:8px;padding:10px"><img src="brand/loopcom-nav-h64@2x.png" alt="Loopcom" style="width:100%"></div>
          <div class="stack" style="gap:5px">${["Talk to us", "See it working", "Start free"].map((c) => `<button class="chip" type="button" style="justify-content:flex-start">${ic("tag", "sm")}${c}</button>`).join("")}</div>
          <p class="help">Approved lines and buttons drop straight in, so nothing off-brand gets typed by hand.</p></div>`,
        Templates: `<div class="grid g2" style="gap:8px">${[["office", 3], ["product", 7], ["city", 9], ["team", 11]].map(([sc, sd]) => `<div class="thumb p45">${art(sc, sd)}</div>`).join("")}</div><p class="help" style="margin-top:8px">Your saved layouts and Loopcom's starters.</p>`,
        Text: `<div class="stack" style="gap:8px">${[["Headline", 26, 700], ["Sub-head", 18, 600], ["Body", 14, 400], ["Eyebrow", 11, 700]].map(([t, s, w]) => `<button class="btn" type="button" style="justify-content:flex-start;font-size:${s}px;font-weight:${w};padding:10px 12px">${t}</button>`).join("")}</div>`,
        Photos: `<div class="grid g2" style="gap:8px">${[["office", 3], ["product", 7], ["support", 5], ["city", 9], ["team", 11], ["phone", 4]].map(([sc, sd]) => `<div class="thumb">${art(sc, sd)}</div>`).join("")}</div>
          <button class="btn sm" type="button" style="margin-top:8px;justify-content:center" data-go="image">${ic("spark", "sm")}Make a new one</button>`,
        Elements: `<div class="grid g3" style="gap:8px">${["square", "circle", "star", "shapes", "arrowr", "wave", "bolt", "heart", "tag"].map((i) => `<button class="btn" type="button" style="justify-content:center;padding:12px 0">${ic(i)}</button>`).join("")}</div>`,
        Uploads: `<div class="drop" style="justify-content:center;padding:18px">${ic("upload")}Drop files</div><div class="grid g2" style="gap:8px;margin-top:8px">${[["product", 7], ["team", 11]].map(([sc, sd]) => `<div class="thumb">${art(sc, sd)}</div>`).join("")}</div>`,
        Layers: `<p class="help">Layers are on the right, next to the properties.</p>`,
      };
      const show = (n) => { panel.innerHTML = PANELS[n] || PANELS.Brand; CS.hydrate(panel); $$("[data-go]", panel).forEach((b) => (b.onclick = () => CS.go(b.dataset.go))); };
      $$("#dTabs button", root).forEach((b, i) => b.addEventListener("click", () => { $$("#dTabs button", root).forEach((x) => x.setAttribute("aria-selected", x === b)); show(PANEL_TABS[i][0]); }));
      show("Brand");
      return;
    }

    /* ---- agent design mode ---- */
    const msgs = $("#aMsgs", root);
    const say = (html, who) => { const d = document.createElement("div"); d.className = who === "you" ? "msg-user" : "msg-ai"; d.innerHTML = who === "you" ? html : `<span class="avatar cw">${ic("loop", "sm")}</span><div class="body">${html}</div>`; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; CS.hydrate(d); return d; };
    const tag = (o, text) => {
      const node = $(`.obj[data-id="${o.id}"]`, canvas); if (!node) return;
      node.classList.add("agent"); CS.later(() => node.classList.remove("agent"), 1000);
      const t = document.createElement("div"); t.className = "agtag"; t.textContent = text;
      t.style.left = o.x + "%"; t.style.top = o.y + "%"; canvas.appendChild(t); CS.later(() => t.remove(), 1800);
    };
    const set = (id, changes, label) => {
      const o = doc.objs.find((x) => x.id === id); if (!o) return;
      Object.assign(o, changes); doc.rev++; rev(); draw(); tag(o, label);
      log(`<b>coworker</b> ${label} <span class="faint">(revision ${doc.rev})</span>`);
    };
    say(`<div class="text">I can see this design — a background photo, a dark overlay, four bits of text and your logo. Tell me what's wrong with it.</div>`);
    $$("[data-ask]", root).forEach((b) => (b.onclick = async () => {
      const kind = b.dataset.ask; b.classList.add("on");
      say(esc(b.textContent.trim()), "you");
      $("#aStatus", root).textContent = "Changing the design…";
      const m = say(`<div class="typing"><i></i><i></i><i></i></div>`);
      await CS.sleep(700);
      if (kind === "expensive") {
        m.querySelector(".body").innerHTML = CS.steps("Changing the design", [
          { tool: "Canvas", icon: "layout", label: "Looked at all 7 layers at revision " + doc.rev, state: "instant", media: true },
          { tool: "Type", icon: "type", label: "Headline 8.6 → 6.4, tighter letter spacing", state: "instant", media: true },
          { tool: "Image", icon: "image", label: "New background: quieter, deeper, shot at dusk", state: "9s", media: true },
          { tool: "Canvas", icon: "move", label: "Text moved onto a 9% margin, overlay softened", state: "instant", media: true },
        ], false, "11s");
        set("head", { size: 6.4, track: "-.01em", y: 64.5 }, "headline smaller");
        await CS.sleep(500); set("bg", { scene: "city", seed: 9 }, "new background");
        await CS.sleep(400); set("scrim", { fill: "linear-gradient(180deg,rgba(4,10,18,.05),rgba(4,10,18,.72))" }, "softer overlay");
        await CS.sleep(300); set("sub", { size: 2.8, y: 78, color: "rgba(255,255,255,.76)" }, "sub-line calmed");
        m.querySelector(".body").insertAdjacentHTML("beforeend", `<div class="text"><p>Four changes: the headline is smaller with tighter spacing, the background is a quieter dusk shot, the dark wash is lighter so the photo shows, and the text now sits on a proper margin. Nothing else moved.</p><div class="row wrap"><button class="btn sm" type="button" id="aUndo">${ic("undo", "sm")}Put it back</button><span class="help">Or just drag anything yourself.</span></div></div>`);
        const u = $("#aUndo", root); u.onclick = () => { set("head", { size: 8.6, track: "0", y: 63 }, "headline restored"); set("bg", { scene: "office", seed: 3 }, "background restored"); CS.toast("Put back", "undo"); };
      } else if (kind === "logo") {
        m.querySelector(".body").innerHTML = CS.steps("Moving the logo", [
          { tool: "Canvas", icon: "layout", label: "Read the design at revision " + doc.rev, state: "instant", media: true },
          { tool: "Canvas", icon: "move", label: "Logo moved to the bottom, 9% margin, clear of the button", state: "instant", media: true },
        ], false, "1s");
        set("logo", { x: 37, y: 93, w: 26 }, "logo → bottom centre");
        m.querySelector(".body").insertAdjacentHTML("beforeend", `<div class="text"><p>Done — bottom centre, on the same margin as the text. <b>Now drag it somewhere yourself</b>, then ask the next one.</p></div>`);
      } else {
        const o = doc.objs.find((x) => x.id === "logo");
        m.querySelector(".body").innerHTML = CS.steps("Sizing and aligning", [
          { tool: "Canvas", icon: "eye", label: `Read the design again — the logo is at x ${o.x.toFixed(1)}% y ${o.y.toFixed(1)}%, width ${o.w.toFixed(0)}%`, state: "instant", media: true },
          { tool: "Canvas", icon: "move", label: "Width −15%, left edge aligned to the headline at 9%", state: "instant", media: true },
        ], false, "1s");
        set("logo", { w: o.w * 0.85, x: 9 }, "logo aligned to the text");
        m.querySelector(".body").insertAdjacentHTML("beforeend", `<div class="text"><p>It's 15% smaller and its left edge lines up with the headline. <b>I used where you left it</b>, not where I put it — I read the design again before touching it.</p></div>`);
      }
      $("#aStatus", root).textContent = "Waiting for you";
      msgs.scrollTop = msgs.scrollHeight;
    }));
  }

  /* =============== TIMELINE EDITOR =============== */
  R("timeline", {
    icon: "film", nav: "Video editor", title: "Video editor",
    crumb: ["Creative Studio", "AI support commercial", "Editor"],
    desc: "The finished film: shots, graphics, captions, voiceover, music and effects on one timeline. The Coworker uses exactly these controls when you ask it to change something.",
    render() {
      return `<div class="grid g2" style="align-items:start;margin-bottom:14px">
        <div>${CS.player("office", 3, { dur: "0:15", cap: 'Your phones never sleep.', id: "tlMon" })}
          <div class="row wrap" style="margin-top:10px"><button class="btn" type="button" id="tlPlay">${ic("play", "sm")}Play</button>
            <span class="pill nub num" id="tlTime">00:04 / 00:15</span><span class="pill nub">1080p · 30fps</span>
            <button class="btn sm" style="margin-left:auto" type="button" data-go="export">${ic("download", "sm")}Export</button></div></div>
        <div class="card" id="tlInsp"></div></div>
      <div class="tlwrap">
        <div class="row wrap" style="margin-bottom:8px"><button class="btn sm" type="button" id="tlSplit">${ic("split", "sm")}Split at playhead</button>
          <button class="btn sm" type="button">${ic("scissors", "sm")}Trim</button><button class="btn sm" type="button">${ic("crop", "sm")}Crop</button>
          <button class="btn sm" type="button">${ic("gauge", "sm")}Speed</button><button class="btn sm" type="button">${ic("type", "sm")}Add text</button>
          <button class="btn sm" type="button">${ic("spark", "sm")}Add logo</button><span class="capchip">${ic("grid", "sm")}Snap</span>
          <div class="row" style="margin-left:auto"><span class="help">Zoom</span><input class="range" type="range" min="40" max="120" value="64" id="tlZoom" style="width:110px"></div></div>
        <div class="tlscroll"><div class="tlinner" id="tlInner"></div></div>
      </div>`;
    },
    init(root) {
      const T = 15;
      let clips = [
        { id: 1, track: 0, s: 0, d: 5, n: "Shot 1 — night floor", k: "video", scene: "office", seed: 3 },
        { id: 2, track: 0, s: 5, d: 5, n: "Shot 2 — answered", k: "video", scene: "support", seed: 5 },
        { id: 3, track: 0, s: 10, d: 5, n: "Shot 3 — end card", k: "video", scene: "loop", seed: 2 },
        { id: 4, track: 1, s: 10.6, d: 4.4, n: "Loopcom mark", k: "gfx" },
        { id: 5, track: 2, s: 0.6, d: 13.4, n: "Captions — burned in", k: "cap" },
        { id: 6, track: 3, s: 1.0, d: 6.2, n: "“Your phones never sleep.”", k: "vo" },
        { id: 7, track: 3, s: 8.4, d: 4.2, n: "“Neither do we.”", k: "vo" },
        { id: 8, track: 4, s: 0, d: 15, n: "Music — slow build (ducked)", k: "music" },
        { id: 9, track: 5, s: 0.2, d: 2.4, n: "Phone ring", k: "sfx" },
        { id: 10, track: 5, s: 5.2, d: 3.0, n: "Room tone", k: "sfx" },
      ];
      const TRACKS = [["Video", "video", "--k-video"], ["Graphics", "layout", "--k-gfx"], ["Captions", "cc", "--k-cap"], ["Voiceover", "mic", "--k-vo"], ["Music", "music", "--k-music"], ["Effects", "wave", "--k-sfx"]];
      const COL = { video: "--k-video", gfx: "--k-gfx", cap: "--k-cap", vo: "--k-vo", music: "--k-music", sfx: "--k-sfx" };
      let sel = 2, head = 4, playing = false, zoom = 64;
      const inner = $("#tlInner", root);
      function draw() {
        const W = T * zoom;
        inner.style.minWidth = W + 110 + "px";
        inner.innerHTML = `<div class="ruler" style="width:${W}px">${Array.from({ length: T + 1 }, (_, i) => `<i style="left:${i * zoom}px">${i}s</i>`).join("")}</div>
          ${TRACKS.map(([n, i, c], ti) => `<div class="track"><span class="tname">${ic(i, "sm")}${n}</span><div class="lanebox" style="width:${W}px">
            ${clips.filter((c2) => c2.track === ti).map((c2) => `<div class="clip ${c2.id === sel ? "sel" : ""}" data-id="${c2.id}" style="left:${c2.s * zoom}px;width:${c2.d * zoom - 3}px;background:var(${COL[c2.k]})">${c2.scene ? `<canvas class="art cw" data-scene="${c2.scene}" data-seed="${c2.seed}"></canvas>` : ""}<span style="position:relative">${esc(c2.n)}</span></div>`).join("")}
          </div></div>`).join("")}
          <div class="playhead" id="tlHead" style="left:${104 + head * zoom}px"></div>`;
        CS.hydrate(inner);
        $$(".clip", inner).forEach((c2) => (c2.onclick = () => { sel = +c2.dataset.id; draw(); insp(); }));
      }
      function insp() {
        const c = clips.find((x) => x.id === sel) || clips[0];
        const box = $("#tlInsp", root);
        box.innerHTML = `<div class="card-h"><h3>${esc(c.n)}</h3><span class="end"><span class="pill nub" style="background:color-mix(in srgb,var(${COL[c.k]}) 18%,transparent);color:var(${COL[c.k]})">${TRACKS[c.track][0]}</span></span></div>
          <div class="grid g2" style="gap:10px">
            <label class="fld">Starts at<input class="input num" value="${c.s.toFixed(1)}s"></label><label class="fld">Length<input class="input num" value="${c.d.toFixed(1)}s"></label></div>
          ${c.k === "video" ? `<div class="stack" style="margin-top:10px"><label class="fld">Speed<input class="range" type="range" min="25" max="200" value="100"><span class="help">100% — normal</span></label>
            <div class="row wrap"><button class="btn sm" type="button">${ic("crop", "sm")}Crop</button><button class="btn sm" type="button">${ic("refresh", "sm")}Re-render this shot</button><button class="btn sm" type="button">${ic("copy", "sm")}Variation</button></div>
            <div class="row"><div style="flex:1"><b style="font-size:13px">Fade in / out</b></div>${CS.sw(false, "Fade")}</div></div>` :
            c.k === "vo" || c.k === "music" || c.k === "sfx" ? `<div class="stack" style="margin-top:10px"><label class="fld">Volume<input class="range" type="range" min="0" max="100" value="${c.k === "music" ? 34 : 88}"></label>
            <div class="row"><div style="flex:1"><b style="font-size:13px">Duck under the voice</b><div class="help">Drops to 18% while anyone is speaking</div></div>${CS.sw(c.k === "music", "Duck")}</div>
            <canvas class="wavecv" data-wave="${c.id}"></canvas>
            ${c.k === "vo" ? `<div class="row wrap"><button class="btn sm" type="button" data-go="audio">${ic("mic", "sm")}Edit the script</button><button class="btn sm" type="button">${ic("refresh", "sm")}Say it again</button></div>` : ""}</div>` :
            c.k === "cap" ? `<div class="stack" style="margin-top:10px"><div class="row wrap"><button class="btn sm" type="button" data-go="audio">${ic("cc", "sm")}Edit captions</button><button class="btn sm" type="button">Style</button></div>
              <div class="row"><div style="flex:1"><b style="font-size:13px">Highlight each word</b></div>${CS.sw(true, "Highlight words")}</div></div>` :
            `<div class="stack" style="margin-top:10px"><div class="row wrap"><button class="btn sm" type="button" data-go="design">${ic("layout", "sm")}Open in the design editor</button></div>
              <div class="row"><div style="flex:1"><b style="font-size:13px">Fade in</b></div>${CS.sw(true, "Fade in")}</div></div>`}
          <div class="divider"></div><div class="row wrap"><button class="btn sm" type="button">${ic("split", "sm")}Split</button><button class="btn sm" type="button">${ic("copy", "sm")}Duplicate</button><button class="btn sm danger" type="button">${ic("trash", "sm")}Delete</button></div>`;
        CS.wireSwitches(box);
        $$("[data-go]", box).forEach((b) => (b.onclick = () => CS.go(b.dataset.go)));
        $$("canvas[data-wave]", box).forEach(wave);
      }
      function wave(cv) {
        const r = cv.getBoundingClientRect(); cv.width = Math.max(200, r.width * 2); cv.height = 68;
        const c = cv.getContext("2d"), n = 90, st = getComputedStyle(document.documentElement).getPropertyValue("--k-vo").trim() || "#1b9e8f";
        c.fillStyle = st;
        for (let i = 0; i < n; i++) { const h = (Math.sin(i * 0.7) * 0.4 + Math.sin(i * 0.23) * 0.4 + 0.55) * 30; c.fillRect((i / n) * cv.width, 34 - h / 2, cv.width / n - 2, h); }
      }
      draw(); insp();
      $("#tlZoom", root).addEventListener("input", (e) => { zoom = +e.target.value; draw(); });
      $("#tlSplit", root).onclick = () => {
        const c = clips.find((x) => x.id === sel); if (!c || head <= c.s || head >= c.s + c.d) return CS.toast("Put the playhead inside the clip first", "alert");
        const right = { ...c, id: Date.now(), s: head, d: c.s + c.d - head, n: c.n + " (2)" }; c.d = head - c.s; clips.push(right); draw(); CS.toast("Split", "split");
      };
      const timeLbl = $("#tlTime", root);
      $("#tlPlay", root).onclick = (e) => {
        playing = !playing;
        e.currentTarget.innerHTML = (playing ? ic("pause", "sm") + "Pause" : ic("play", "sm") + "Play");
        const mon = $("#tlMon canvas", root); if (mon) mon.dataset.anim = "1";
      };
      CS.every(() => {
        if (!playing) return; head = (head + 0.12) % T;
        const h = $("#tlHead", root); if (h) h.style.left = 104 + head * zoom + "px";
        timeLbl.textContent = `00:${String(Math.floor(head)).padStart(2, "0")} / 00:15`;
        const mon = $("#tlMon canvas", root), cur = clips.find((c) => c.track === 0 && head >= c.s && head < c.s + c.d);
        if (mon && cur && mon.dataset.scene !== cur.scene) { mon.dataset.scene = cur.scene; mon.dataset.seed = cur.seed; }
        const cap = $("#tlMon .capline", root); if (cap) cap.innerHTML = head < 7 ? "Your phones never sleep." : head < 12 ? "<em>Neither do we.</em>" : "";
      }, 120);
    },
  });

  /* =============== VOICE, MUSIC & CAPTIONS =============== */
  R("audio", {
    icon: "mic", nav: "Voice, music & captions", title: "Voice, music and captions",
    crumb: ["Creative Studio", "AI support commercial", "Sound"],
    desc: "The voiceover is written as sentences, so any one line can be re-recorded without touching the rest.",
    render() {
      const LINES = [["Your phones never sleep.", "0:01 – 0:04", "ok"], ["Neither do we.", "0:08 – 0:10", "ok"], ["Loopcom. Set up in a day.", "0:11 – 0:14", "re"]];
      return `<div class="grid g2" style="align-items:start">
        <div class="stack">
          <div class="card"><div class="card-h"><h3>Voiceover</h3><span class="end"><button class="btn sm">${ic("refresh", "sm")}Redo all</button></span></div>
            <div class="grid g2" style="gap:10px;margin-bottom:12px"><label class="fld">Voice<select class="select"><option>Rachel — warm, unhurried</option><option>Daniel — steady, low</option><option>Malky — our spokesperson</option><option>Yiddish — Shimon</option></select></label>
              <label class="fld">Delivery<select class="select"><option>Calm</option><option>Confident</option><option>Friendly</option><option>Urgent</option></select></label></div>
            <div class="stack" style="gap:8px">${LINES.map(([t, w, st], i) => `<div class="row" style="align-items:flex-start;border:1px solid var(--border);border-radius:10px;padding:9px 11px">
              <span class="pill nub num">${i + 1}</span><div style="flex:1"><div contenteditable="true" style="font-size:13.5px;outline:none">${t}</div><div class="help">${w} · 1.9s ${st === "re" ? "· <b style='color:var(--warning)'>re-recording</b>" : ""}</div></div>
              <button class="iconbtn" type="button" aria-label="Play">${ic("play", "sm")}</button><button class="iconbtn" type="button" aria-label="Say it again">${ic("refresh", "sm")}</button></div>`).join("")}</div>
            <div class="divider"></div>
            <div class="card-h"><h3 style="font-size:13px">How to say things</h3><span class="sub">Kept for every video you make</span></div>
            <div class="twrap"><table class="t"><thead><tr><th>Word</th><th>Say it like</th><th></th></tr></thead><tbody>
              ${[["Loopcom", "LOOP-com"], ["VoIP", "voyp"], ["Gesheft", "geh-SHEFT"], ["SIP", "sip"]].map(([a, b]) => `<tr><td><b>${a}</b></td><td class="mono">${b}</td><td class="r"><button class="iconbtn" aria-label="Remove">${ic("x", "sm")}</button></td></tr>`).join("")}
            </tbody></table></div>
            <button class="btn sm" type="button" style="margin-top:10px">${ic("plus", "sm")}Add a word</button></div>
          <div class="card"><div class="card-h"><h3>Captions</h3><span class="end">${CS.sw(true, "Show captions")}</span></div>
            <div class="stage" style="padding:12px"><div class="player" style="aspect-ratio:16/9;width:min(100%,420px)">${art("support", 5)}<div class="capline" style="bottom:22px">Neither <em>do we.</em></div>
              <div style="position:absolute;inset:8%;border:1px dashed rgba(255,255,255,.35);border-radius:6px"></div></div></div>
            <div class="row wrap" style="margin-top:10px"><div class="chips" data-single>${["Bold white", "Boxed", "Karaoke", "Minimal"].map((t, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${t}</button>`).join("")}</div></div>
            <div class="stack" style="margin-top:10px;gap:8px">
              <div class="row"><div style="flex:1"><b style="font-size:13px">Highlight each word as it is said</b></div>${CS.sw(true, "Highlight words")}</div>
              <div class="row"><div style="flex:1"><b style="font-size:13px">Keep inside the safe area</b><div class="help">The dashed box — platform buttons sit outside it</div></div>${CS.sw(true, "Safe area")}</div>
              <div class="row"><div style="flex:1"><b style="font-size:13px">Also save a subtitle file</b><div class="help">.srt alongside the video</div></div>${CS.sw(true, "Subtitle file")}</div></div>
            <div class="note info" style="margin-top:10px">${ic("cc")}<div>Captions are written from the voiceover automatically, and you can edit any word. For Yiddish, the same transcription path the phone system already uses is what reads it.</div></div></div>
        </div>
        <div class="stack">
          <div class="card"><div class="card-h"><h3>Music</h3><span class="end"><button class="btn sm">${ic("refresh", "sm")}Another</button></span></div>
            <div class="stack" style="gap:9px">${[["Slow build — strings and pulse", "0:15", true], ["Warm piano", "0:22", false], ["Quiet pad", "0:18", false]].map(([t, d, on]) => `
              <div class="row" style="border:1px solid var(--border);border-radius:10px;padding:8px 10px;${on ? "border-color:var(--accent);background:var(--accent-soft)" : ""}">
                <button class="iconbtn" type="button" aria-label="Play">${ic("play", "sm")}</button><div style="flex:1"><b style="font-size:12.5px">${t}</b><div class="help">${d} · generated · cleared for commercial use</div></div>${on ? `<span class="pill info nub">In use</span>` : `<button class="btn sm" type="button">Use</button>`}</div>`).join("")}</div>
            <div class="divider"></div>
            <label class="fld">Volume under the voice<input class="range" type="range" min="0" max="100" value="18"><span class="help">18% while anyone speaks, 34% otherwise</span></label>
            <svg viewBox="0 0 300 70" class="diagram" style="height:78px" role="img" aria-label="Music volume dipping while the voice speaks">
              <rect x="0" y="0" width="300" height="70" fill="none"></rect>
              <path d="M0 24 L60 24 L70 50 L150 50 L160 24 L200 24 L210 50 L280 50 L290 30 L300 30" fill="none" stroke="var(--k-music)" stroke-width="2.5"></path>
              <rect x="70" y="8" width="80" height="12" rx="3" fill="var(--k-vo)"></rect><rect x="210" y="8" width="70" height="12" rx="3" fill="var(--k-vo)"></rect>
              <text x="6" y="16" font-size="9" fill="var(--text-dim)">voice</text><text x="6" y="66" font-size="9" fill="var(--text-dim)">music ducks under it</text></svg></div>
          <div class="card"><div class="card-h"><h3>Sound effects</h3></div>
            <div class="stack" style="gap:8px">${[["Phone ring — desk phone", "0:00.2"], ["Room tone — small shop", "0:05.2"], ["Soft whoosh on the end card", "not used"]].map(([t, w]) => `<div class="row"><span class="faint">${ic("wave", "sm")}</span><div style="flex:1"><b style="font-size:12.5px">${t}</b><div class="help">${w}</div></div><button class="btn sm" type="button">${w === "not used" ? "Add" : "Replace"}</button></div>`).join("")}</div>
            <div class="divider"></div><div class="seclbl">Where sound can come from</div>
            <div class="stack" style="gap:6px">${[["Generated for you", "Cleared for commercial use. Where it came from is recorded."], ["Your own uploads", "You tell us you have the right to use it."], ["The Loopcom library", "Licensed for every customer."]].map(([t, d]) => `<div class="row" style="align-items:flex-start"><span class="ok-ic">${ic("check", "sm")}</span><div><b style="font-size:12.5px">${t}</b><div class="help">${d}</div></div></div>`).join("")}</div></div>
        </div></div>`;
    },
  });
})();
