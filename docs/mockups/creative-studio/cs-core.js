/* Loopcom Creative Studio mockup — core runtime: icons, procedural placeholder art, router helpers.
   Everything here is disposable prototype code. Example data only. */
(function () {
  const CS = (window.CS = { screens: {}, order: [], state: { mode: "user", tenant: "loopcom" } });

  /* ---------------- icons ---------------- */
  const I = {
    menu: "M4 6h16M4 12h16M4 18h16", search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4",
    loop: "M12 12c-2-2.8-4-4-6-4a4 4 0 0 0 0 8c2 0 4-1.2 6-4zm0 0c2 2.8 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.2-6 4z",
    home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
    spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
    image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15.5 8.5h.01", video: "M3 6h13v12H3zM16 10l5-3v10l-5-3",
    film: "M4 3h16v18H4zM8 3v18M16 3v18M4 8h4M4 13h4M4 18h4M16 8h4M16 13h4M16 18h4",
    layout: "M3 4h18v16H3zM3 9h18M9 9v11",
    palette: "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-1.2-1-1.4-1-2.4 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.1-4-7.5-9-7.5zM7.5 11h.01M9.5 7.5h.01M14.5 7.5h.01",
    folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    layers: "M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5",
    history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
    brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4z",
    download: "M12 4v11M7 10l5 5 5-5M5 20h14", upload: "M12 16V5M7 10l5-5 5 5M5 20h14",
    gear: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
    cpu: "M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4",
    list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01", chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
    users: "M9 11a4 4 0 1 0 0-8a4 4 0 1 0 0 8M2 21v-1a6 6 0 0 1 12 0v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6",
    play: "M7 4l13 8-13 8z", pause: "M7 4h3v16H7zM14 4h3v16h-3z",
    scissors: "M6 9a3 3 0 1 0 0-6a3 3 0 1 0 0 6M6 21a3 3 0 1 0 0-6a3 3 0 1 0 0 6M8.1 8.1L20 20M8.1 15.9L20 4",
    type: "M4 7V4h16v3M9 20h6M12 4v16", square: "M4 4h16v16H4z", circle: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18",
    wand: "M15 4V2M15 10V8M11 6h2M17 6h2M3 21l12-12M13.5 7.5l3 3",
    plus: "M12 5v14M5 12h14", x: "M6 6l12 12M18 6L6 18", check: "M5 12.5l4.5 4.5L19 7.5",
    alert: "M12 3l10 18H2zM12 10v5M12 18h.01",
    refresh: "M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4",
    more: "M5 12h.01M12 12h.01M19 12h.01", lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
    unlock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 7.5-2", copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
    move: "M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3",
    alignc: "M12 3v18M7 7h10M5 12h14M8 17h8", undo: "M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3",
    redo: "M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3", zoomin: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4M8 11h6M11 8v6",
    mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3M5 11a7 7 0 0 0 14 0M12 18v3",
    music: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0M21 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0",
    volume: "M4 9h4l5-4v14l-5-4H4zM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11",
    cc: "M3 5h18v14H3zM10 10.5a2 2 0 1 0 0 3M17 10.5a2 2 0 1 0 0 3",
    chev: "M9 6l6 6-6 6", chevd: "M6 9l6 6 6-6", grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
    star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z",
    pin: "M12 17v5M8 3h8l-1 6 3 3v2H6v-2l3-3z",
    eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6",
    clock: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 7v5l3 2",
    dollar: "M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
    server: "M3 4h18v7H3zM3 13h18v7H3zM7 7.5h.01M7 16.5h.01", gauge: "M12 14l4-4M3.5 17a9 9 0 1 1 17 0",
    bell: "M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4", send: "M12 19V5M5 12l7-7 7 7", msg: "M4 5h16v11H9l-5 4z",
    crop: "M6 2v14h14M2 6h14v14", eraser: "M16 3l5 5-11 11H5l-3-3zM9 9l6 6M13 21h8",
    brush: "M18 3l3 3-9 9-3-3zM9 12c-3 0-5 2-5 5 0 1.5-1 3-2 3 2 1 6 1 8-1 1.5-1.5 1.5-4 .5-5z",
    maximize: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7", arrowr: "M5 12h14M13 6l6 6-6 6",
    wave: "M2 12h2M6 8v8M10 5v14M14 9v6M18 7v10M22 12h-2", split: "M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5",
    shapes: "M3 14h7v7H3zM17.5 3l4 7h-8zM17.5 14a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7",
    expand: "M3 9V3h6M21 9V3h-6M3 15v6h6M21 15v6h-6",
    branch: "M6 3v12M18 9a3 3 0 1 0 0-6a3 3 0 1 0 0 6M6 21a3 3 0 1 0 0-6a3 3 0 1 0 0 6M18 9a9 9 0 0 1-9 9",
    compare: "M12 3v18M4 5h5v14H4zM15 5h5v14h-5z",
    thumbup: "M7 10v11H3V10zM7 10l4-8a3 3 0 0 1 3 3v4h6a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.6 21H7",
    thumbdown: "M17 14V3h4v11zM17 14l-4 8a3 3 0 0 1-3-3v-4H4a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 5.4 3H17",
    camera: "M3 7h4l2-3h6l2 3h4v13H3zM12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7",
    phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2",
    stop: "M6 6h12v12H6z", key: "M8 15a4 4 0 1 0 0-8a4 4 0 1 0 0 8M11 11h10M18 11v3M15 11v2",
    database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
    bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
    link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    smartphone: "M7 2h10v20H7zM11 18h2", template: "M3 3h18v6H3zM3 13h8v8H3zM15 13h6v8h-6z",
    ban: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M5.6 5.6l12.8 12.8",
    globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
    heart: "M12 20s-7-4.5-9-9a5 5 0 0 1 9-3 5 5 0 0 1 9 3c-2 4.5-9 9-9 9z",
    ratio: "M3 6h18v12H3zM7 10v4M17 10v4",
    megaphone: "M3 10v4h3l7 5V5L6 10zM17 8a5 5 0 0 1 0 8",
    file: "M6 2h8l5 5v15H6zM14 2v5h5",
    tag: "M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01",
    grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4",
    target: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 11.5h.01",
    activity: "M3 12h4l3-8 4 16 3-8h4",
  };
  const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  sprite.setAttribute("style", "display:none");
  sprite.innerHTML = Object.entries(I).map(([k, d]) => `<symbol id="i-${k}" viewBox="0 0 24 24"><path d="${d}"/></symbol>`).join("");
  document.body.prepend(sprite);
  CS.ic = (n, cls = "") => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

  /* ---------------- helpers ---------------- */
  CS.$ = (s, r = document) => r.querySelector(s);
  CS.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  CS.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  CS.sleep = (ms) => new Promise((r) => CS.later(r, ms));
  const timers = new Set();
  CS.every = (fn, ms) => { const id = setInterval(fn, ms); timers.add(["i", id]); return id; };
  CS.later = (fn, ms) => { const id = setTimeout(fn, ms); timers.add(["t", id]); return id; };
  CS.clearTimers = () => { timers.forEach(([k, id]) => (k === "i" ? clearInterval(id) : clearTimeout(id))); timers.clear(); CS.runId = (CS.runId || 0) + 1; };
  CS.toast = (msg, icon = "check") => {
    const el = document.createElement("div");
    el.className = "toast"; el.setAttribute("role", "status");
    el.innerHTML = CS.ic(icon, "sm") + CS.esc(msg);
    document.body.appendChild(el); setTimeout(() => el.remove(), 2400);
  };
  CS.modal = ({ title, body, footer = "", wide = false, onMount }) => {
    const root = CS.$("#modalRoot");
    root.innerHTML = `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-label="${CS.esc(title)}" style="${wide ? "width:min(1000px,100%)" : ""}">
      <div class="modal-h"><h3>${title}</h3><button class="iconbtn" type="button" data-close aria-label="Close">${CS.ic("x")}</button></div>
      <div class="modal-b">${body}</div>${footer ? `<div class="modal-f">${footer}</div>` : ""}</div></div>`;
    const close = () => { root.innerHTML = ""; };
    CS.$$("[data-close]", root).forEach((b) => (b.onclick = close));
    CS.$(".modal-back", root).addEventListener("mousedown", (e) => { if (e.target.classList.contains("modal-back")) close(); });
    CS.hydrate(root);
    onMount && onMount(CS.$(".modal", root), close);
    return close;
  };
  CS.register = (id, def) => { CS.screens[id] = Object.assign({ id }, def); CS.order.push(id); };
  CS.money = (n) => "$" + n.toFixed(2);

  /* ---------------- procedural placeholder art ---------------- */
  function rng(seed) { let s = (seed * 9301 + 49297) >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  const lin = (c, x0, y0, x1, y1, st) => { const g = c.createLinearGradient(x0, y0, x1, y1); st.forEach(([o, col]) => g.addColorStop(o, col)); return g; };
  const rad = (c, x, y, r0, r1, st) => { const g = c.createRadialGradient(x, y, r0, x, y, r1); st.forEach(([o, col]) => g.addColorStop(o, col)); return g; };
  function rr(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function bokeh(c, w, h, R, n, cols, t, drift = 6) {
    for (let i = 0; i < n; i++) {
      const x = (R() * w + t * drift * (R() - 0.3) * 4) % (w + 40), y = R() * h, r = (0.01 + R() * 0.05) * w;
      c.fillStyle = rad(c, x, y, 0, r, [[0, cols[i % cols.length]], [1, "rgba(0,0,0,0)"]]);
      c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    }
  }
  function vignette(c, w, h, a = 0.55) { c.fillStyle = rad(c, w / 2, h / 2, Math.min(w, h) * 0.3, Math.max(w, h) * 0.75, [[0, "rgba(0,0,0,0)"], [1, `rgba(0,0,0,${a})`]]); c.fillRect(0, 0, w, h); }
  function person(c, x, y, s, fill, headset) {
    c.fillStyle = fill;
    c.beginPath(); c.ellipse(x, y, 1.55 * s, 1.25 * s, 0, Math.PI, 0); c.fill();
    c.fillRect(x - 0.28 * s, y - 1.55 * s, 0.56 * s, 0.4 * s);
    c.beginPath(); c.ellipse(x, y - 1.95 * s, 0.56 * s, 0.66 * s, 0, 0, 7); c.fill();
    if (headset) {
      c.strokeStyle = fill; c.lineWidth = 0.12 * s;
      c.beginPath(); c.arc(x, y - 1.98 * s, 0.7 * s, Math.PI * 1.05, Math.PI * 1.95); c.stroke();
      c.beginPath(); c.moveTo(x + 0.62 * s, y - 1.8 * s); c.quadraticCurveTo(x + 0.7 * s, y - 1.25 * s, x + 0.2 * s, y - 1.3 * s); c.stroke();
    }
  }
  function lemni(c, cx, cy, a, u) { const s = Math.sin(u), co = Math.cos(u), d = 1 + s * s; return [cx + (a * co) / d, cy + (a * s * co) / d]; }
  function skyline(c, w, h, R, base, col, lit, off = 0) {
    let x = -((off % 80) + 80);
    while (x < w + 40) {
      const bw = w * (0.04 + R() * 0.07), bh = h * (0.12 + R() * 0.38);
      c.fillStyle = col; c.fillRect(x, base - bh, bw, bh);
      for (let yy = base - bh + 6; yy < base - 6; yy += 7) for (let xx = x + 4; xx < x + bw - 4; xx += 6) {
        if (R() < 0.33) { c.fillStyle = lit[(R() * lit.length) | 0]; c.fillRect(xx, yy, 2.4, 3); }
      }
      x += bw + 2;
    }
  }

  const SCENES = {
    office(c, w, h, t, R) {
      c.fillStyle = lin(c, 0, 0, 0, h, [[0, "#06101e"], [0.7, "#12294a"], [1, "#0b1a30"]]); c.fillRect(0, 0, w, h);
      skyline(c, w, h, R, h * 0.7, "#0a1426", ["rgba(255,196,120,.55)", "rgba(120,190,255,.5)", "rgba(255,255,255,.35)"], t * 6);
      c.fillStyle = "rgba(120,180,255,.06)"; for (let i = 1; i < 5; i++) c.fillRect((w / 5) * i, 0, 2, h * 0.72);
      c.fillStyle = lin(c, 0, h * 0.72, 0, h, [[0, "#0a1422"], [1, "#03060b"]]); c.fillRect(0, h * 0.72, w, h);
      const mx = w * 0.53 + Math.sin(t * 0.4) * w * 0.004, my = h * 0.45, mw = w * 0.26, mh = h * 0.2;
      c.fillStyle = rad(c, mx + mw / 2, my + mh / 2, 0, w * 0.45, [[0, "rgba(60,160,255,.35)"], [1, "rgba(0,0,0,0)"]]); c.fillRect(0, 0, w, h);
      c.save(); c.shadowColor = "#3ab0ff"; c.shadowBlur = w * 0.04;
      c.fillStyle = lin(c, mx, my, mx + mw, my + mh, [[0, "#6fd6ff"], [1, "#2a64f0"]]); rr(c, mx, my, mw, mh, 4); c.fill(); c.restore();
      c.fillStyle = "rgba(255,255,255,.75)"; for (let i = 0; i < 4; i++) c.fillRect(mx + mw * 0.08, my + mh * (0.2 + i * 0.17), mw * (0.35 + R() * 0.45), mh * 0.06);
      c.fillStyle = "#04080f"; c.fillRect(mx + mw * 0.45, my + mh, mw * 0.1, h * 0.08);
      person(c, w * 0.4 + 2, h * 0.84, w * 0.085, "rgba(90,180,255,.35)", true);
      person(c, w * 0.4, h * 0.845, w * 0.085, "#02050a", true);
      vignette(c, w, h, 0.5);
    },
    support(c, w, h, t, R) {
      c.fillStyle = rad(c, w * 0.6, h * 0.45, 0, w * 0.8, [[0, "#12305c"], [1, "#03070e"]]); c.fillRect(0, 0, w, h);
      bokeh(c, w, h, R, 14, ["rgba(60,150,255,.25)", "rgba(120,90,255,.18)"], t);
      const panels = [[0.55, 0.16, 0.3, 0.22], [0.66, 0.44, 0.27, 0.2], [0.5, 0.7, 0.24, 0.15]];
      panels.forEach(([px, py, pw, ph], i) => {
        const x = px * w, y = py * h + Math.sin(t * 1.2 + i) * h * 0.012, W = pw * w, H = ph * h;
        c.save(); c.shadowColor = "#39a6ff"; c.shadowBlur = 18;
        c.strokeStyle = "rgba(130,200,255,.75)"; c.lineWidth = 1.2; c.fillStyle = "rgba(60,140,255,.10)";
        rr(c, x, y, W, H, 8); c.fill(); c.stroke(); c.restore();
        c.fillStyle = "rgba(180,225,255,.7)";
        for (let k = 0; k < 3; k++) { const bw = W * (0.3 + R() * 0.45), right = k % 2 === 1; rr(c, right ? x + W - bw - W * 0.07 : x + W * 0.07, y + H * (0.14 + k * 0.28), bw, H * 0.17, 5); c.fill(); }
      });
      person(c, w * 0.3 + 3, h * 0.97, w * 0.11, "rgba(80,170,255,.4)", true);
      person(c, w * 0.3, h * 0.975, w * 0.11, "#02050b", true);
      for (let i = 0; i < 40; i++) { c.fillStyle = `rgba(140,210,255,${0.2 + R() * 0.5})`; c.fillRect((R() * w + t * 10) % w, (R() * h - t * 6 + h) % h, 1.5, 1.5); }
      vignette(c, w, h, 0.55);
    },
    loop(c, w, h, t, R) {
      c.fillStyle = rad(c, w / 2, h / 2, 0, w * 0.7, [[0, "#0b2448"], [0.6, "#050b16"], [1, "#020409"]]); c.fillRect(0, 0, w, h);
      for (let i = 0; i < 60; i++) { const a = R() * 7 + t * 0.2 * (R() - 0.5), d = (0.2 + R() * 0.5) * w; c.fillStyle = `rgba(120,200,255,${R() * 0.6})`; c.fillRect(w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d * 0.55, 1.6, 1.6); }
      const A = Math.min(w * 0.36, h * 0.8);
      const draw = (lw, style, blur) => { c.save(); c.shadowColor = "#22a8ff"; c.shadowBlur = blur; c.strokeStyle = style; c.lineWidth = lw; c.beginPath(); for (let u = 0; u <= 6.3; u += 0.04) { const [x, y] = lemni(c, w / 2, h / 2, A, u); u === 0 ? c.moveTo(x, y) : c.lineTo(x, y); } c.closePath(); c.stroke(); c.restore(); };
      draw(A * 0.11, lin(c, w * 0.2, 0, w * 0.8, 0, [[0, "#4f7bff"], [0.5, "#22a8ff"], [1, "#4f7bff"]]), A * 0.25);
      draw(A * 0.03, "rgba(230,246,255,.9)", 6);
      const [hx, hy] = lemni(c, w / 2, h / 2, A, t * 1.1);
      c.fillStyle = rad(c, hx, hy, 0, A * 0.18, [[0, "rgba(255,255,255,.95)"], [1, "rgba(34,168,255,0)"]]); c.beginPath(); c.arc(hx, hy, A * 0.18, 0, 7); c.fill();
      c.save(); c.translate(w / 2, h / 2); c.fillStyle = "rgba(255,255,255,.95)"; const f = A * (0.28 + Math.sin(t * 2) * 0.03);
      c.beginPath(); c.ellipse(0, 0, f, A * 0.012, 0, 0, 7); c.fill(); c.beginPath(); c.ellipse(0, 0, A * 0.012, f * 0.55, 0, 0, 7); c.fill();
      c.fillStyle = rad(c, 0, 0, 0, A * 0.12, [[0, "rgba(255,255,255,1)"], [1, "rgba(34,168,255,0)"]]); c.beginPath(); c.arc(0, 0, A * 0.12, 0, 7); c.fill(); c.restore();
    },
    phone(c, w, h, t, R) {
      c.fillStyle = lin(c, 0, 0, w, h, [[0, "#1e2a44"], [1, "#0a111d"]]); c.fillRect(0, 0, w, h);
      bokeh(c, w, h, R, 16, ["rgba(255,170,90,.28)", "rgba(80,160,255,.25)", "rgba(255,255,255,.12)"], t, 2);
      c.save(); c.translate(w * 0.52, h * 0.55); c.rotate(-0.12 + Math.sin(t * 0.5) * 0.01);
      const pw = Math.min(w * 0.24, h * 0.5), ph = pw * 1.95;
      c.shadowColor = "rgba(0,0,0,.6)"; c.shadowBlur = 30; c.fillStyle = "#05070b"; rr(c, -pw / 2, -ph / 2, pw, ph, pw * 0.14); c.fill(); c.shadowBlur = 0;
      c.fillStyle = lin(c, 0, -ph / 2, 0, ph / 2, [[0, "#10203a"], [1, "#0a1424"]]); rr(c, -pw / 2 + 5, -ph / 2 + 5, pw - 10, ph - 10, pw * 0.11); c.fill();
      c.fillStyle = "#22a8ff"; c.fillRect(-pw / 2 + 5, -ph / 2 + 5 + pw * 0.14, pw - 10, 2);
      c.fillStyle = "rgba(255,255,255,.85)"; c.font = `600 ${pw * 0.075}px Inter,sans-serif`; c.fillText("Loopcom AI Support", -pw / 2 + pw * 0.12, -ph / 2 + pw * 0.12);
      const msgs = [[0, 0.62], [1, 0.5], [0, 0.7], [1, 0.42]];
      msgs.forEach(([me, bw], i) => { const y = -ph / 2 + pw * 0.3 + i * pw * 0.28, W = (pw - 30) * bw; c.fillStyle = me ? "#2f8cff" : "rgba(255,255,255,.14)"; rr(c, me ? pw / 2 - 12 - W : -pw / 2 + 12, y, W, pw * 0.2, 8); c.fill(); });
      for (let i = 0; i < 3; i++) { c.fillStyle = `rgba(255,255,255,${0.3 + 0.5 * Math.max(0, Math.sin(t * 5 - i))})`; c.beginPath(); c.arc(-pw / 2 + 24 + i * 9, -ph / 2 + pw * 1.5, 3, 0, 7); c.fill(); }
      c.restore(); vignette(c, w, h, 0.45);
    },
    city(c, w, h, t, R) {
      c.fillStyle = lin(c, 0, 0, 0, h, [[0, "#1b2a55"], [0.45, "#7a4f8f"], [0.72, "#ff9a5c"], [1, "#2a1d2e"]]); c.fillRect(0, 0, w, h);
      c.fillStyle = rad(c, w * 0.7, h * 0.68, 0, w * 0.25, [[0, "rgba(255,220,160,.95)"], [1, "rgba(255,150,80,0)"]]); c.fillRect(0, 0, w, h);
      skyline(c, w, h, R, h * 0.9, "#120d1c", ["rgba(255,200,130,.7)", "rgba(255,240,200,.5)"], t * 3);
      c.fillStyle = "#08060d"; c.fillRect(0, h * 0.9, w, h);
      bokeh(c, w, h, R, 10, ["rgba(255,190,120,.25)"], t, 4); vignette(c, w, h, 0.4);
    },
    product(c, w, h, t, R) {
      c.fillStyle = rad(c, w * 0.5, h * 0.35, 0, w * 0.8, [[0, "#f4f7fb"], [1, "#9fb0c4"]]); c.fillRect(0, 0, w, h);
      c.fillStyle = "rgba(20,30,45,.25)"; c.beginPath(); c.ellipse(w * 0.5, h * 0.82, w * 0.3, h * 0.05, 0, 0, 7); c.fill();
      const bx = w * 0.3, by = h * 0.42, bw = w * 0.42, bh = h * 0.36;
      c.fillStyle = lin(c, bx, by, bx, by + bh, [[0, "#2a3442"], [1, "#11161e"]]);
      c.beginPath(); c.moveTo(bx + bw * 0.12, by); c.lineTo(bx + bw, by); c.lineTo(bx + bw * 1.02, by + bh); c.lineTo(bx - bw * 0.05, by + bh); c.closePath(); c.fill();
      c.save(); c.shadowColor = "#5ec9ff"; c.shadowBlur = 12; c.fillStyle = lin(c, 0, by, 0, by + bh * 0.3, [[0, "#9fe2ff"], [1, "#3a86ff"]]); rr(c, bx + bw * 0.45, by + bh * 0.1, bw * 0.45, bh * 0.28, 4); c.fill(); c.restore();
      c.fillStyle = "#8fa0b5"; for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) { c.beginPath(); c.arc(bx + bw * (0.52 + k * 0.14), by + bh * (0.5 + r * 0.12), bw * 0.025, 0, 7); c.fill(); }
      c.fillStyle = lin(c, bx, 0, bx + bw * 0.3, 0, [[0, "#1a212c"], [1, "#39465a"]]); rr(c, bx + bw * 0.04, by - bh * 0.05, bw * 0.3, bh * 0.95, bw * 0.12); c.fill();
      const sx = ((t * 0.25) % 1.6 - 0.3) * w; c.fillStyle = lin(c, sx - 60, 0, sx + 60, 0, [[0, "rgba(255,255,255,0)"], [0.5, "rgba(255,255,255,.35)"], [1, "rgba(255,255,255,0)"]]); c.fillRect(bx - 20, by - 30, bw + 40, bh + 40);
    },
    waves(c, w, h, t) {
      c.fillStyle = "#040a15"; c.fillRect(0, 0, w, h);
      for (let k = 0; k < 6; k++) {
        c.strokeStyle = lin(c, 0, 0, w, 0, [[0, "rgba(34,168,255,0)"], [0.5, k % 2 ? "rgba(124,108,240,.8)" : "rgba(34,168,255,.85)"], [1, "rgba(79,123,255,0)"]]);
        c.lineWidth = 1.5 + k * 1.3; c.beginPath();
        for (let x = 0; x <= w; x += 6) { const y = h * 0.5 + Math.sin(x / w * 6 + t * (0.6 + k * 0.1) + k) * h * (0.08 + k * 0.03) + (k - 3) * h * 0.04; x ? c.lineTo(x, y) : c.moveTo(x, y); }
        c.stroke();
      }
      vignette(c, w, h, 0.5);
    },
    dashboard(c, w, h, t, R) {
      c.fillStyle = "#08111e"; c.fillRect(0, 0, w, h);
      const P = (x, y, W, H) => { c.fillStyle = "rgba(255,255,255,.04)"; c.strokeStyle = "rgba(120,180,255,.18)"; rr(c, x, y, W, H, 8); c.fill(); c.stroke(); };
      P(w * 0.05, h * 0.08, w * 0.9, h * 0.12);
      P(w * 0.05, h * 0.26, w * 0.55, h * 0.66); P(w * 0.64, h * 0.26, w * 0.31, h * 0.31); P(w * 0.64, h * 0.61, w * 0.31, h * 0.31);
      for (let i = 0; i < 4; i++) { c.fillStyle = "rgba(255,255,255,.7)"; c.fillRect(w * (0.08 + i * 0.22), h * 0.12, w * 0.08, h * 0.02); c.fillStyle = "#22a8ff"; c.fillRect(w * (0.08 + i * 0.22), h * 0.155, w * 0.12, h * 0.025); }
      c.save(); c.shadowColor = "#22a8ff"; c.shadowBlur = 10; c.strokeStyle = "#22a8ff"; c.lineWidth = 2.5; c.beginPath();
      const grow = Math.min(1, (t % 6) / 3);
      for (let i = 0; i <= 20 * grow; i++) { const x = w * (0.08 + i * 0.024), y = h * (0.8 - (0.1 + 0.35 * (i / 20) + Math.sin(i * 0.9) * 0.05)); i ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.stroke(); c.restore();
      for (let i = 0; i < 6; i++) { const bh = h * (0.05 + R() * 0.17); c.fillStyle = i % 2 ? "#4f7bff" : "#22a8ff"; c.fillRect(w * (0.68 + i * 0.043), h * 0.53 - bh, w * 0.026, bh); }
      c.lineWidth = w * 0.02; c.strokeStyle = "rgba(255,255,255,.1)"; c.beginPath(); c.arc(w * 0.795, h * 0.765, h * 0.1, 0, 7); c.stroke();
      c.strokeStyle = "#34c27b"; c.beginPath(); c.arc(w * 0.795, h * 0.765, h * 0.1, -1.57, -1.57 + 4.6); c.stroke();
    },
    team(c, w, h, t, R) {
      c.fillStyle = lin(c, 0, 0, w, 0, [[0, "#2b1d18"], [0.5, "#5a3b2a"], [1, "#2a1c16"]]); c.fillRect(0, 0, w, h);
      c.fillStyle = lin(c, 0, 0, 0, h * 0.6, [[0, "#ffe7bf"], [1, "#f5b774"]]); c.fillRect(w * 0.3, h * 0.08, w * 0.4, h * 0.5);
      c.fillStyle = "rgba(80,50,30,.5)"; for (let i = 0; i < 7; i++) c.fillRect(w * 0.3, h * (0.1 + i * 0.07), w * 0.4, h * 0.012);
      c.fillStyle = lin(c, w * 0.5, h * 0.3, w * 0.5, h, [[0, "rgba(255,214,150,.35)"], [1, "rgba(255,214,150,0)"]]);
      c.beginPath(); c.moveTo(w * 0.3, h * 0.58); c.lineTo(w * 0.7, h * 0.58); c.lineTo(w * 0.95, h); c.lineTo(w * 0.05, h); c.fill();
      [[0.24, 0.8, 0.075], [0.5, 0.74, 0.07], [0.76, 0.8, 0.075]].forEach(([x, y, s], i) => person(c, w * x + Math.sin(t + i) * 1.5, h * y, w * s, "#140c09", false));
      c.fillStyle = "#1a110d"; c.beginPath(); c.ellipse(w * 0.5, h * 0.9, w * 0.42, h * 0.1, 0, 0, 7); c.fill();
      vignette(c, w, h, 0.45);
    },
    clinic(c, w, h, t, R) {
      c.fillStyle = lin(c, 0, 0, 0, h, [[0, "#eef8f7"], [1, "#cfe6e7"]]); c.fillRect(0, 0, w, h);
      c.fillStyle = "#ffffff"; c.fillRect(w * 0.08, h * 0.1, w * 0.36, h * 0.5);
      c.fillStyle = "rgba(160,210,210,.5)"; c.fillRect(w * 0.255, h * 0.1, 3, h * 0.5);
      c.fillStyle = "#a9d4d2"; c.fillRect(0, h * 0.72, w, h * 0.3);
      c.fillStyle = "#3f8f7e"; for (let i = 0; i < 7; i++) { c.beginPath(); c.ellipse(w * 0.86 + Math.sin(i) * w * 0.03, h * (0.5 + i * 0.03), w * 0.03, h * 0.07, i * 0.5, 0, 7); c.fill(); }
      c.fillStyle = "#e7eeee"; c.fillRect(w * 0.55, h * 0.55, w * 0.25, h * 0.22);
      person(c, w * 0.62, h * 0.82, w * 0.085, "#2c7a78", false);
      c.fillStyle = "#f2d6c3"; c.beginPath(); c.ellipse(w * 0.62, h * 0.82 - w * 0.085 * 1.95, w * 0.085 * 0.5, w * 0.085 * 0.6, 0, 0, 7); c.fill();
    },
    abstract(c, w, h, t, R) {
      c.fillStyle = "#0b0f1d"; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 5; i++) { const x = w * (0.2 + R() * 0.6) + Math.sin(t * 0.4 + i) * 20, y = h * (0.2 + R() * 0.6); c.fillStyle = rad(c, x, y, 0, w * 0.35, [[0, ["rgba(34,168,255,.55)", "rgba(124,108,240,.5)", "rgba(79,123,255,.45)"][i % 3]], [1, "rgba(0,0,0,0)"]]); c.fillRect(0, 0, w, h); }
    },
  };
  function glitch(c, w, h, R) {
    for (let i = 0; i < 9; i++) { const y = R() * h, hh = 4 + R() * 18, dx = (R() - 0.5) * w * 0.12; const img = c.getImageData(0, y, w, hh); c.putImageData(img, dx, y); }
    c.fillStyle = "rgba(255,40,80,.12)"; c.fillRect(0, 0, w, h);
  }
  CS.paint = (cv, t = 0) => {
    const scene = cv.dataset.scene || "abstract", seed = +(cv.dataset.seed || 1);
    const r = cv.getBoundingClientRect(); const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const W = Math.max(40, Math.round((r.width || 320) * dpr)), H = Math.max(24, Math.round((r.height || 180) * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const c = cv.getContext("2d"); c.setTransform(1, 0, 0, 1, 0, 0);
    try { (SCENES[scene] || SCENES.abstract)(c, W, H, t + seed * 0.7, rng(seed)); if (cv.dataset.glitch) glitch(c, W, H, rng(seed + 3)); } catch (e) { c.fillStyle = "#111"; c.fillRect(0, 0, W, H); }
  };
  CS.art = (scene, seed = 1, extra = "") => `<canvas class="art" data-scene="${scene}" data-seed="${seed}" ${extra} aria-hidden="true"></canvas>`;
  let anims = new Set(), raf = 0, t0 = performance.now();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  CS.hydrate = (root) => {
    CS.$$("canvas.art", root).forEach((cv) => { CS.paint(cv, 0); if (cv.dataset.anim && !reduce) anims.add(cv); });
    if (anims.size && !raf) loop();
  };
  let last = 0;
  function loop(now = performance.now()) {
    raf = requestAnimationFrame(loop);
    if (now - last < 40) return; last = now;
    const t = (now - t0) / 1000;
    anims.forEach((cv) => { if (!cv.isConnected) { anims.delete(cv); return; } if (cv.dataset.paused) return; const r = cv.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) return; CS.paint(cv, cv.dataset.t ? +cv.dataset.t : t); });
    if (!anims.size) { cancelAnimationFrame(raf); raf = 0; }
  }
  let rsz = 0;
  addEventListener("resize", () => { clearTimeout(rsz); rsz = setTimeout(() => CS.$$("canvas.art").forEach((cv) => CS.paint(cv, 0)), 180); });

  /* ---------------- small shared renderers ---------------- */
  CS.steps = (title, steps, working, time = "") => `<div class="cw-steps"><div class="cw-steps-h">${working ? '<span class="spin" style="width:11px;height:11px"></span><b>Working</b>' : `<span class="ok-ic">${CS.ic("check", "sm")}</span><b>Done</b>`}<span>· ${CS.esc(title)}</span><span class="t">${time}</span></div>${steps.map((s) => {
    const lead = s.st === "run" ? '<span class="spin"></span>' : s.st === "wait" ? `<span class="warn-ic">${CS.ic("alert", "sm")}</span>` : s.st === "fail" ? `<span class="bad-ic">${CS.ic("x", "sm")}</span>` : s.st === "todo" ? `<span class="faint">${CS.ic("circle", "sm")}</span>` : `<span class="ok-ic">${CS.ic("check", "sm")}</span>`;
    return `<div class="cw-step">${lead}<span class="tool ${s.media ? "media" : ""}">${CS.ic(s.icon || "spark", "sm")}${s.tool}</span><span class="lab">${s.label}</span><span class="st">${s.state || ""}</span></div>`;
  }).join("")}</div>`;
  CS.player = (scene, seed, { ratio = "16/9", dur = "0:15", cap = "", anim = true, id = "" } = {}) => `<div class="player" style="aspect-ratio:${ratio}" ${id ? `id="${id}"` : ""}>${CS.art(scene, seed, anim ? 'data-anim="1"' : "")}${cap ? `<div class="capline">${cap}</div>` : ""}<div class="ctrl"><button type="button" aria-label="Play">${CS.ic("pause", "sm")}</button><span class="num">0:04</span><div class="bar"><i style="width:28%"></i></div><span class="num">${dur}</span><button type="button" aria-label="Volume">${CS.ic("volume", "sm")}</button><button type="button" aria-label="Full screen">${CS.ic("maximize", "sm")}</button></div></div>`;
  CS.sw = (on, label) => `<button type="button" class="sw" role="switch" aria-checked="${on}" aria-label="${CS.esc(label)}"></button>`;
  CS.wireSwitches = (root) => CS.$$(".sw", root).forEach((b) => b.addEventListener("click", () => b.setAttribute("aria-checked", b.getAttribute("aria-checked") !== "true")));
  CS.wireChips = (root, sel = ".chips[data-single]") => CS.$$(sel, root).forEach((g) => g.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (!b) return; CS.$$(".chip", g).forEach((x) => x.classList.toggle("on", x === b)); g.dispatchEvent(new CustomEvent("pick", { detail: b.dataset.v || b.textContent.trim() })); }));
})();
