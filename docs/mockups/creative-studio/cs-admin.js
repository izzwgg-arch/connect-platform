/* Platform-admin screens for Creative Studio. Example data only. */
(function () {
  const { ic, esc, art, $, $$ } = CS;
  const R = (id, d) => CS.register(id, d);

  const bars = (data, colors, h = 120, labels = []) => {
    const max = Math.max(...data.map((d) => d.reduce((a, b) => a + b, 0))) || 1;
    const w = 100 / data.length;
    return `<svg viewBox="0 0 320 ${h + 22}" class="diagram" style="height:${h + 28}px" role="img" aria-label="Daily spend by kind of job">
      ${[0.25, 0.5, 0.75, 1].map((f) => `<line x1="0" y1="${h - f * h}" x2="320" y2="${h - f * h}" stroke="var(--border)" stroke-width="1"></line>`).join("")}
      <text x="2" y="10" font-size="8" fill="var(--text-dim)">${CS.money(max)}</text>
      ${data.map((stack, i) => { let y = h; return stack.map((v, k) => { const bh = (v / max) * h; y -= bh; return `<rect x="${i * (320 / data.length) + 1.5}" y="${y}" width="${320 / data.length - 3}" height="${Math.max(0, bh)}" fill="${colors[k]}" rx="1.5"></rect>`; }).join(""); }).join("")}
      ${labels.map((l, i) => `<text x="${i * (320 / labels.length) + 2}" y="${h + 14}" font-size="8" fill="var(--text-dim)">${l}</text>`).join("")}
    </svg>`;
  };
  const spark = (pts, color, h = 46) => {
    const max = Math.max(...pts) || 1, step = 300 / (pts.length - 1);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)} ${(h - (p / max) * (h - 6)).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 300 ${h}" style="width:100%;height:${h}px" role="img" aria-label="Queue depth over the last hour"><path d="${d}" fill="none" stroke="${color}" stroke-width="2"></path>
      <circle cx="300" cy="${(h - (pts[pts.length - 1] / max) * (h - 6)).toFixed(1)}" r="3" fill="${color}"></circle></svg>`;
  };

  /* =============== ADMIN DASHBOARD =============== */
  R("adash", {
    icon: "gauge", nav: "Console", title: "Creative Studio console",
    crumb: ["Admin", "Creative Studio"],
    desc: "Platform staff only. What is running, what it costs, and what is broken.",
    actions: `<span class="pill ok">All engines up</span><button class="btn" type="button" data-go="aqueue">${ic("list", "sm")}Queue</button>`,
    render() {
      const K = [["Jobs today", "412", "38 running, 6 queued", "activity"], ["Spend today", "$64.18", "$1,206 this month", "dollar"],
        ["Median render", "41s", "95th: 2m 18s", "clock"], ["Failed", "2.1%", "9 of 412 · 6 auto-recovered", "alert"],
        ["GPU hours", "7.4", "3 workers · 62% busy", "cpu"], ["Storage", "1.24 TB", "+86 GB this week", "database"]];
      return `<div class="kpis" style="margin-bottom:14px">${K.map(([l, v, d, i]) => `<div class="kpi"><span class="l">${ic(i, "sm")}${l}</span><span class="v">${v}</span><span class="d">${d}</span></div>`).join("")}</div>
      <div class="grid g2" style="margin-bottom:14px">
        <div class="card"><div class="card-h"><h3>Spend, last 14 days</h3><span class="end"><span class="legend"><span><i style="background:var(--k-video)"></i>Video</span><span><i style="background:var(--k-gfx)"></i>Images</span><span><i style="background:var(--k-vo)"></i>Audio</span></span></span></div>
          ${bars([[18, 6, 1], [24, 7, 1], [31, 9, 2], [12, 4, 1], [8, 3, 1], [29, 11, 2], [36, 12, 3], [41, 9, 2], [22, 8, 1], [19, 6, 1], [44, 14, 3], [38, 10, 2], [51, 12, 3], [47, 15, 2]], ["var(--k-video)", "var(--k-gfx)", "var(--k-vo)"], 120, ["", "", "", "", "5 Sep", "", "", "", "", "10 Sep", "", "", "", "15 Sep"])}
          <p class="help">Video is 78% of spend. The biggest single lever is defaulting people to Draft for first attempts.</p></div>
        <div class="card"><div class="card-h"><h3>Queue depth, last hour</h3><span class="end"><span class="pill ok">healthy</span></span></div>
          ${spark([2, 3, 1, 4, 6, 9, 14, 11, 7, 5, 8, 12, 9, 6, 4, 3, 6, 5, 4, 6], "var(--accent)")}
          <div class="grid g3" style="gap:10px;margin-top:10px"><div class="kpi" style="padding:9px 10px"><span class="l">Waiting</span><span class="v" style="font-size:18px">6</span></div>
            <div class="kpi" style="padding:9px 10px"><span class="l">Running</span><span class="v" style="font-size:18px">38</span></div>
            <div class="kpi" style="padding:9px 10px"><span class="l">Longest wait</span><span class="v" style="font-size:18px">54s</span></div></div></div></div>
      <div class="grid g3">
        <div class="card"><div class="card-h"><h3>Engines</h3><span class="end"><button class="btn sm ghost" type="button" data-go="amodels">All</button></span></div>
          <div class="stack" style="gap:8px">${[["Loopcom image · fast", "ok", "1.9s median"], ["Loopcom image · detailed", "ok", "7.1s"], ["Loopcom video · production", "ok", "48s"], ["Loopcom video · fast", "warn", "slow — 2m 41s"], ["On our own machines", "ok", "3m 20s"], ["Voice (ElevenLabs)", "ok", "1.2s"]].map(([n, s, m]) => `<div class="row"><span class="pill ${s} nub" style="width:8px;height:8px;padding:0;border-radius:50%;background:var(--${s === "ok" ? "success" : "warning"})"></span><b style="font-size:12.5px;flex:1">${n}</b><span class="help">${m}</span></div>`).join("")}</div></div>
        <div class="card"><div class="card-h"><h3>Workers</h3><span class="end"><button class="btn sm ghost" type="button" data-go="aworkers">All</button></span></div>
          <div class="stack" style="gap:10px">${[["gpu-l40s-01", 74, "ok"], ["gpu-l40s-02", 51, "ok"], ["render-cpu-01", 22, "ok"]].map(([n, v, s]) => `<div class="meter"><span>${n.split("-").slice(-1)}</span><div class="bar ${v > 85 ? "warn" : ""}"><i style="width:${v}%"></i></div><span class="num">${v}%</span></div>`).join("")}</div>
          <p class="help" style="margin-top:8px">All three sent a heartbeat in the last 10 seconds.</p></div>
        <div class="card"><div class="card-h"><h3>Needs a look</h3></div>
          <div class="stack" style="gap:8px">
            <div class="note warn" style="padding:8px 10px">${ic("alert", "sm")}<div style="font-size:12px"><b>Loopcom video · fast</b> is 3× slower than usual. 4 jobs re-routed to production automatically.</div></div>
            <div class="note bad" style="padding:8px 10px">${ic("ban", "sm")}<div style="font-size:12px"><b>2 jobs failed twice</b> and were handed back to the customer with a plain explanation.</div></div>
            <div class="note" style="padding:8px 10px">${ic("gauge", "sm")}<div style="font-size:12px"><b>Loopcom Demo</b> is at 92% of its monthly video seconds.</div></div></div></div></div>`;
    },
  });

  /* =============== MODELS & PROVIDERS =============== */
  R("amodels", {
    icon: "cpu", nav: "Engines", title: "Engines and providers",
    crumb: ["Admin", "Creative Studio", "Engines"],
    desc: "What the studio is allowed to use. Nothing whose licence forbids commercial use can be switched on here — the licence is shown on every row and checked in code.",
    actions: `<button class="btn" type="button">${ic("plus", "sm")}Add a provider</button>`,
    render() {
      const rows = [
        ["Image", "Loopcom image · fast", "Open weights · Apache-2.0", "yes", "Our GPU", "$0.004", "1.9s", "94%", true, true],
        ["Image", "Loopcom image · detailed", "Open weights · Apache-2.0", "yes", "Our GPU", "$0.011", "7.1s", "96%", true, false],
        ["Image", "Loopcom image · text-in-picture", "Open weights · Apache-2.0", "yes", "Our GPU", "$0.013", "8.4s", "97%", true, false],
        ["Image", "External · premium image", "Commercial API", "yes", "External", "$0.04", "6.2s", "97%", true, false],
        ["Image", "Community-licence model", "Free under $1M revenue", "review", "Our GPU", "$0.006", "3.1s", "92%", false, false],
        ["Image", "Non-commercial research model", "Research only", "no", "—", "—", "—", "—", false, false],
        ["Video", "Loopcom video · production", "Commercial API", "yes", "External", "$0.10/s", "48s", "95%", true, true],
        ["Video", "Loopcom video · fast", "Commercial API", "yes", "External", "$0.04/s", "2m 41s", "91%", true, false],
        ["Video", "On our own machines", "Open weights · Apache-2.0", "yes", "Our GPU", "GPU time", "3m 20s", "88%", true, false],
        ["Video", "Territory-restricted model", "Excludes EU / UK / KR", "no", "—", "—", "—", "—", false, false],
        ["Cut out", "Background removal", "Open source · MIT", "yes", "Our GPU", "free", "0.9s", "99%", true, true],
        ["Enlarge", "Upscaler", "Open source · BSD", "yes", "Our GPU", "free", "2.2s", "99%", true, true],
        ["Voice", "ElevenLabs voice", "Commercial API", "yes", "External", "$0.05/min", "1.2s", "99%", true, true],
        ["Music", "ElevenLabs music", "Commercial API", "yes", "External", "$0.15/min", "14s", "97%", true, true],
      ];
      return `<div class="note warn" style="margin-bottom:14px">${ic("shield")}<div><b>The licence column is the gate, not a note.</b> A model marked <b>no</b> cannot be enabled at all, and one marked <b>review</b> needs a written decision on file before it can be made a default — several popular open models are free to try and not free to sell with.</div></div>
      <div class="twrap"><table class="t"><thead><tr><th>Job</th><th>Engine</th><th>Licence</th><th>Can we sell with it</th><th>Where</th><th class="r">Cost</th><th class="r">Median</th><th class="r">Good first time</th><th>On</th><th>Default</th></tr></thead><tbody>
        ${rows.map(([job, n, lic, ok, where, cost, med, q, on, def]) => `<tr><td class="muted">${job}</td><td><b>${n}</b></td><td class="muted">${lic}</td>
          <td>${ok === "yes" ? `<span class="pill ok">Yes</span>` : ok === "review" ? `<span class="pill warn">Needs a decision</span>` : `<span class="pill bad">No</span>`}</td>
          <td class="muted">${where}</td><td class="r">${cost}</td><td class="r">${med}</td><td class="r">${q}</td>
          <td>${ok === "no" ? `<span class="faint">${ic("lock", "sm")}</span>` : CS.sw(on, "Enable " + n)}</td>
          <td>${def ? `<span class="pill info nub">Default</span>` : ok === "no" ? "" : `<button class="btn sm" type="button">Make default</button>`}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><div class="card-h"><h3>How a job is routed</h3><span class="sub">In order</span></div>
          <ol class="steps-ol" style="font-size:13px"><li>Is the tenant allowed this kind of job at all?</li><li>Which engines are enabled <b>and</b> licensed for commercial use?</li><li>Did the customer pin one? If so, use it.</li><li>Otherwise rank the rest on how often they come out right, how fast they are, and what they cost — using the scorecard, not a hunch.</li><li>If the first choice is down or slow, fall to the next and record that it happened.</li></ol></div>
        <div class="card"><div class="card-h"><h3>Scorecard</h3><span class="sub">Last 30 days · platform-wide, no customer content</span></div>
          <div class="twrap"><table class="t"><thead><tr><th>Engine</th><th class="r">Runs</th><th class="r">Accepted first time</th><th class="r">Median</th><th class="r">Cost per accepted</th></tr></thead><tbody>
            ${[["Loopcom image · detailed", "3,914", "81%", "7.1s", "$0.014"], ["Loopcom image · fast", "9,220", "62%", "1.9s", "$0.006"], ["Loopcom video · production", "1,204", "74%", "48s", "$0.68"], ["Loopcom video · fast", "2,881", "49%", "2m 41s", "$0.31"], ["On our own machines", "612", "58%", "3m 20s", "$0.19"]]
              .map(([n, r, a, m, c]) => `<tr><td>${n}</td><td class="r">${r}</td><td class="r">${a}</td><td class="r">${m}</td><td class="r">${c}</td></tr>`).join("")}
          </tbody></table></div>
          <p class="help" style="margin-top:8px">“Accepted first time” means the customer kept it without asking for another. It is the number that decides routing.</p></div></div>`;
    },
  });

  /* =============== GPU WORKERS =============== */
  R("aworkers", {
    icon: "server", nav: "Workers", title: "Render workers",
    crumb: ["Admin", "Creative Studio", "Workers"],
    desc: "Machines that do the rendering. They are separate from the Loopcom phone platform on purpose — a busy render must never slow a phone call down.",
    actions: `<button class="btn" type="button">${ic("plus", "sm")}Add a worker</button>`,
    render() {
      const W = [["gpu-l40s-01", "Rented GPU · L40S 48 GB", "busy", 74, 61, "Shot 2 of job 8f21", "9s ago", "2026.09.2"],
        ["gpu-l40s-02", "Rented GPU · L40S 48 GB", "busy", 51, 44, "Image batch, job 91a4", "4s ago", "2026.09.2"],
        ["render-cpu-01", "Loopcom server · CPU only", "busy", 22, 12, "Joining shots, job 8f21", "2s ago", "2026.09.2"],
        ["gpu-a100-01", "Rented GPU · A100 80 GB", "asleep", 0, 0, "—", "—", "2026.09.2"],
        ["gpu-l40s-03", "Rented GPU · L40S 48 GB", "lost", 0, 0, "Job 77c0 — handed back to the queue", "4m 12s ago", "2026.08.4"]];
      return `<div class="grid g3" style="margin-bottom:14px">${W.map(([n, kind, st, gpu, vram, job, hb, ver]) => `
        <div class="wcard"><div class="wh"><span class="dot-scope" style="background:${st === "lost" ? "var(--bad-soft)" : st === "asleep" ? "var(--panel-3)" : "var(--ok-soft)"};color:${st === "lost" ? "var(--danger)" : st === "asleep" ? "var(--text-faint)" : "var(--success)"}">${ic("server", "sm")}</span>
          <div style="flex:1"><b style="font-size:13px">${n}</b><div class="help">${kind}</div></div>
          <span class="pill ${st === "lost" ? "bad" : st === "asleep" ? "" : "ok"}">${st === "lost" ? "Lost" : st === "asleep" ? "Asleep" : "Working"}</span></div>
          <div class="meter"><span>GPU</span><div class="bar ${gpu > 85 ? "warn" : ""}"><i style="width:${gpu}%"></i></div><span class="num">${gpu}%</span></div>
          <div class="meter"><span>Memory</span><div class="bar"><i style="width:${vram}%"></i></div><span class="num">${vram}%</span></div>
          <div class="kv" style="font-size:11.5px"><dt>Doing</dt><dd style="text-align:right">${job}</dd><dt>Heartbeat</dt><dd>${hb}</dd><dt>Version</dt><dd class="mono">${ver}</dd></div>
          <div class="row wrap" style="gap:6px"><button class="btn sm" type="button">${ic("pause", "sm")}Stop giving it work</button><button class="btn sm" type="button">${ic("refresh", "sm")}Restart</button><button class="btn sm ghost" type="button">Logs</button></div></div>`).join("")}</div>
      <div class="grid g2">
        <div class="card"><div class="card-h"><h3>When a worker dies</h3><span class="sub">What happened to gpu-l40s-03 four minutes ago</span></div>
          <ol class="steps-ol" style="font-size:13px"><li>It stopped sending heartbeats. After 60 seconds its claim on the job expired.</li><li>Job 77c0 went back into the queue with everything it had already finished intact — only the unfinished shot is redone.</li><li>Another worker picked it up 3 seconds later. The customer saw “still rendering”, nothing else.</li><li>The provider was billed for the lost work and it shows in the cost report, marked as waste.</li><li>The worker is left out of rotation until a human looks at it. It is still on an old version, which is the first thing to check.</li></ol>
          <div class="note ok" style="margin-top:10px">${ic("check")}<div>No customer job is ever tied to one machine, and closing Loopcom never cancels anything.</div></div></div>
        <div class="card"><div class="card-h"><h3>Capacity</h3></div>
          <div class="twrap"><table class="t"><thead><tr><th>Pool</th><th>Machines</th><th>What it takes</th><th class="r">Cost</th><th class="r">Busy</th></tr></thead><tbody>
            ${[["Images", "2 × L40S 48 GB", "Pictures, cut-outs, enlarging", "$1.09/hr each", "68%"], ["Video", "1 × A100 80 GB (asleep)", "Our own video engine", "$1.59/hr", "0%"], ["Joining and exporting", "1 × CPU on the Loopcom server", "FFmpeg only — no GPU needed", "included", "22%"], ["External providers", "—", "Production video, voice, music", "per second", "—"]]
              .map(([a, b, c, d, e]) => `<tr><td><b>${a}</b></td><td class="muted">${b}</td><td class="muted">${c}</td><td class="r">${d}</td><td class="r">${e}</td></tr>`).join("")}
          </tbody></table></div>
          <div class="note info" style="margin-top:10px">${ic("bolt")}<div><b>Nothing runs on a GPU we own today.</b> There is no GPU anywhere in Loopcom — not on the server, not on any desk. Phase 1 uses external providers only; GPU workers are rented by the hour and sleep when idle.</div></div></div></div>`;
    },
  });

  /* =============== QUEUE =============== */
  R("aqueue", {
    icon: "list", nav: "Queue", title: "Jobs",
    crumb: ["Admin", "Creative Studio", "Jobs"],
    desc: "Every generation and render, across every company.",
    render() {
      const J = [["8f21", "Loopcom Demo", "Video · production", "Running", "Shot 3 of 3", "gpu — external", "2m 14s", "$2.40"],
        ["91a4", "Northside Dental", "Images · 4", "Running", "78%", "gpu-l40s-02", "9s", "$0.17"],
        ["77c0", "Loopcom Demo", "Video · own machines", "Re-queued", "worker lost — retrying", "—", "4m 31s", "$0.00"],
        ["6b02", "Hillside Hardware", "Join and export", "Running", "encoding 9:16", "render-cpu-01", "22s", "included"],
        ["5aa9", "Northside Dental", "Video · fast", "Waiting", "3rd in line", "—", "51s", "$0.32"],
        ["4c17", "Loopcom Demo", "Voiceover", "Done", "19 words", "external", "1.2s", "$0.05"],
        ["3f88", "Hillside Hardware", "Images · 8", "Failed", "engine refused the prompt twice", "gpu-l40s-01", "14s", "$0.00"]];
      return `<div class="row wrap" style="margin-bottom:12px"><div class="chips" data-single>${["All", "Waiting", "Running", "Failed", "Done"].map((t, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${t}</button>`).join("")}</div>
        <input class="input" placeholder="Job id, company or engine" style="max-width:260px;margin-left:auto"></div>
      <div class="twrap"><table class="t"><thead><tr><th>Job</th><th>Company</th><th>Kind</th><th>State</th><th>Where it is</th><th>Worker</th><th class="r">Age</th><th class="r">Cost</th><th></th></tr></thead><tbody>
        ${J.map(([id, t, k, st, w, wk, a, c]) => `<tr><td class="mono">${id}</td><td>${t}</td><td class="muted">${k}</td>
          <td><span class="pill ${st === "Done" ? "ok" : st === "Failed" ? "bad" : st === "Running" ? "info" : "warn"}">${st}</span></td>
          <td class="muted">${w}</td><td class="mono faint">${wk}</td><td class="r muted">${a}</td><td class="r">${c}</td>
          <td class="r"><button class="btn sm" type="button">${st === "Failed" ? "Retry" : st === "Done" ? "Open" : "Cancel"}</button></td></tr>`).join("")}
      </tbody></table></div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><div class="card-h"><h3>What a job goes through</h3></div>
          <div class="row wrap" style="gap:6px">${["Queued", "Claimed", "Running", "Checking", "Retrying", "Done", "Failed", "Cancelled"].map((s, i) => `<span class="pill ${s === "Done" ? "ok" : s === "Failed" ? "bad" : s === "Retrying" ? "warn" : "info"} nub">${s}</span>${i < 7 ? `<span class="faint">${ic("chev", "sm")}</span>` : ""}`).join("")}</div>
          <ul style="margin-top:10px;font-size:13px;padding-left:18px;display:grid;gap:5px" class="muted">
            <li>A job is claimed by exactly one worker and held by a lease it must keep renewing.</li>
            <li>The same request sent twice uses the same key and does not render twice.</li>
            <li>Cancel reaches the provider too, not just our side.</li>
            <li>Finished work inside a part-done job is kept — a retry only redoes what is missing.</li></ul></div>
        <div class="card"><div class="card-h"><h3>Failures today</h3></div>
          <div class="twrap"><table class="t"><thead><tr><th>Reason</th><th class="r">Count</th><th class="r">Recovered by itself</th></tr></thead><tbody>
            ${[["Our own check failed the result", "6", "6"], ["Provider timed out", "2", "2"], ["Provider refused the prompt", "2", "0"], ["Worker lost", "1", "1"], ["Out of allowance", "3", "n/a"]].map(([a, b, c]) => `<tr><td>${a}</td><td class="r">${b}</td><td class="r">${c}</td></tr>`).join("")}
          </tbody></table></div>
          <p class="help" style="margin-top:8px">A refused prompt is shown to the customer in plain English. Everything else is retried at most twice before anyone is told.</p></div></div>`;
    },
  });

  /* =============== USAGE & COST =============== */
  R("ausage", {
    icon: "dollar", nav: "Usage and cost", title: "Usage and cost",
    crumb: ["Admin", "Creative Studio", "Usage"],
    desc: "What the studio costs to run, per company and per kind of job.",
    render() {
      return `<div class="kpis" style="margin-bottom:14px">${[["This month", "$1,206.40", "budget $2,000", "dollar"], ["GPU rental", "$214.80", "142 hours", "cpu"], ["External providers", "$948.10", "video 78%", "globe"],
        ["Storage", "$18.60", "1.24 TB", "database"], ["Wasted on retries", "$24.90", "2.1% of spend", "refresh"], ["Busiest company", "Loopcom Demo", "$402 · 33%", "users"]]
        .map(([l, v, d, i]) => `<div class="kpi"><span class="l">${ic(i, "sm")}${l}</span><span class="v" style="font-size:${v.length > 9 ? 17 : 23}px">${v}</span><span class="d">${d}</span></div>`).join("")}</div>
      <div class="grid g2" style="margin-bottom:14px">
        <div class="card"><div class="card-h"><h3>Spend by kind of job</h3><span class="end"><span class="legend"><span><i style="background:var(--k-video)"></i>Video</span><span><i style="background:var(--k-gfx)"></i>Images</span><span><i style="background:var(--k-vo)"></i>Audio</span></span></span></div>
          ${bars([[310, 74, 12], [286, 88, 14], [352, 96, 18]], ["var(--k-video)", "var(--k-gfx)", "var(--k-vo)"], 110, ["July", "August", "September"])}</div>
        <div class="card"><div class="card-h"><h3>What we count</h3></div>
          <div class="twrap"><table class="t"><thead><tr><th>Measure</th><th>Where it comes from</th><th class="r">This month</th></tr></thead><tbody>
            ${[["GPU seconds", "Worker reports each job", "511,000"], ["Provider charges", "Their own billing lines", "$948.10"], ["Frames rendered", "The render step", "84,220"],
              ["Stored bytes", "Nightly count per company", "1.24 TB"], ["Failed renders", "Jobs that ended badly", "31"], ["Retries", "Second and third attempts", "88"]]
              .map(([a, b, c]) => `<tr><td><b>${a}</b></td><td class="muted">${b}</td><td class="r">${c}</td></tr>`).join("")}
          </tbody></table></div></div></div>
      <div class="card"><div class="card-h"><h3>By company</h3><span class="sub">Cost to us, not what anyone is charged</span></div>
        <div class="twrap"><table class="t"><thead><tr><th>Company</th><th class="r">Jobs</th><th class="r">Video seconds</th><th class="r">Images</th><th class="r">Storage</th><th class="r">Cost</th><th class="r">Share</th></tr></thead><tbody>
          ${[["Loopcom Demo", "1,204", "612", "3,880", "410 GB", "$402.10", "33%"], ["Northside Dental", "861", "388", "2,140", "220 GB", "$286.40", "24%"],
            ["Hillside Hardware", "640", "244", "1,760", "180 GB", "$204.80", "17%"], ["Everyone else (12)", "1,902", "506", "4,220", "430 GB", "$313.10", "26%"]]
            .map(([a, b, c, d, e, f, g]) => `<tr><td><b>${a}</b></td><td class="r">${b}</td><td class="r">${c}</td><td class="r">${d}</td><td class="r">${e}</td><td class="r">${f}</td><td class="r">${g}</td></tr>`).join("")}
        </tbody></table></div>
        <div class="note info" style="margin-top:12px">${ic("dollar")}<div>These are our costs. Whether any of it is passed on to customers, and how, is a billing decision that has not been made — nothing here touches the invoice engine.</div></div></div>`;
    },
  });

  /* =============== TENANT LIMITS =============== */
  R("alimits", {
    icon: "gauge", nav: "Company limits", title: "Company limits",
    crumb: ["Admin", "Creative Studio", "Limits"],
    desc: "How much each company may use, and which engines they may reach.",
    render() {
      const T = [["Loopcom Demo", "120", "92%", "unlimited", "50 GB", "3", "yes"], ["Northside Dental", "60", "64%", "1,000", "20 GB", "2", "no"],
        ["Hillside Hardware", "60", "41%", "1,000", "20 GB", "2", "no"], ["Gesheft", "0", "—", "200", "5 GB", "1", "no"]];
      return `<div class="twrap"><table class="t"><thead><tr><th>Company</th><th class="r">Video seconds / month</th><th class="r">Used</th><th class="r">Images / month</th><th class="r">Storage</th><th class="r">At once</th><th>Premium engines</th><th></th></tr></thead><tbody>
        ${T.map(([n, v, u, i, s, c, p]) => `<tr><td><b>${n}</b></td><td class="r">${v}</td><td class="r">${u === "—" ? `<span class="faint">—</span>` : `<span class="pill ${parseInt(u) > 85 ? "warn" : "ok"} nub">${u}</span>`}</td><td class="r">${i}</td><td class="r">${s}</td><td class="r">${c}</td>
          <td>${CS.sw(p === "yes", "Premium for " + n)}</td><td class="r"><button class="btn sm" type="button">Change</button></td></tr>`).join("")}
      </tbody></table></div>
      <div class="grid g2" style="margin-top:14px">
        <div class="card"><div class="card-h"><h3>What happens at the limit</h3></div>
          <div class="stack" style="gap:9px">${[["At 80%", "The account owner is told, once.", "info"], ["At 100%", "New video jobs are refused in plain English. Images and designs keep working.", "warn"],
            ["Running jobs", "Always finish. A limit never kills work in flight.", "ok"], ["Reset", "On the 1st, in the company's own time zone.", "info"]]
            .map(([a, b, k]) => `<div class="note ${k}" style="padding:9px 11px">${ic(k === "ok" ? "check" : k === "warn" ? "alert" : "bell", "sm")}<div style="font-size:12.5px"><b>${a}</b> — ${b}</div></div>`).join("")}</div></div>
        <div class="card"><div class="card-h"><h3>Who can do what</h3><span class="sub">Set per company in the ordinary roles screens</span></div>
          <div class="twrap"><table class="t"><thead><tr><th>Permission</th><th>In which bucket by default</th></tr></thead><tbody>
            ${[["See Creative Studio", "none — granting it is the launch"], ["Make images", "none"], ["Make video", "none"], ["Use premium engines", "none"],
              ["Manage the brand kit", "none"], ["Export", "none"], ["See the whole company's projects", "none"], ["Delete projects", "none"], ["Run this console", "platform staff only"]]
              .map(([a, b]) => `<tr><td>${a}</td><td class="muted">${b}</td></tr>`).join("")}
          </tbody></table></div>
          <p class="help" style="margin-top:8px">Every one of these appears in both permission screens — the In-sidebar switch and the custom-role matrix — in the same commit as the page itself.</p></div></div>`;
    },
  });

  /* =============== AUDIT =============== */
  R("aaudit", {
    icon: "shield", nav: "Audit log", title: "Audit log",
    crumb: ["Admin", "Creative Studio", "Audit"],
    desc: "Who did what, and what the Coworker did on their behalf. Kept whether it succeeded or not.",
    render() {
      const L = [["14:41:02", "Coworker", "Loopcom Demo", "exported project 44c1 as WhatsApp Status", "ok", "on behalf of Jacob L."],
        ["14:40:11", "Coworker", "Loopcom Demo", "changed the end card: logo 34% → 24%", "ok", "revision 41 → 42"],
        ["14:39:58", "Jacob L.", "Loopcom Demo", "approved $2.40 of rendering", "ok", "from the Coworker chat"],
        ["14:38:40", "Coworker", "Loopcom Demo", "started job 8f21 — 3 shots, production", "ok", "$2.40 estimated"],
        ["14:36:22", "Coworker", "Loopcom Demo", "read the brand kit", "ok", "read only"],
        ["14:31:07", "Ezra W.", "Loopcom Demo", "uploaded team-photo-aug.jpg", "ok", "checked, re-encoded"],
        ["14:22:55", "Coworker", "Northside Dental", "tried to read a brand kit in another company", "denied", "not found — blocked before the query"],
        ["13:58:03", "Izzy W.", "platform", "turned on “Loopcom video · fast” for everyone", "ok", "engine setting"],
        ["13:44:12", "system", "Hillside Hardware", "refused a prompt", "denied", "provider policy — customer told plainly"]];
      return `<div class="row wrap" style="margin-bottom:12px"><div class="chips" data-single>${["Everything", "Coworker only", "People only", "Denied", "Money"].map((t, i) => `<button class="chip ${i === 0 ? "on" : ""}" type="button">${t}</button>`).join("")}</div>
        <input class="input" placeholder="Company, person or job" style="max-width:260px;margin-left:auto"></div>
      <div class="twrap"><table class="t"><thead><tr><th>Time</th><th>Who</th><th>Company</th><th>What</th><th>Result</th><th>Detail</th></tr></thead><tbody>
        ${L.map(([t, who, tn, what, r, d]) => `<tr><td class="mono faint">${t}</td><td>${who === "Coworker" ? `<span class="row" style="gap:6px"><span class="avatar cw" style="width:20px;height:20px">${ic("loop", "sm")}</span>Coworker</span>` : `<b>${who}</b>`}</td>
          <td class="muted">${tn}</td><td>${what}</td><td><span class="pill ${r === "ok" ? "ok" : "bad"}">${r === "ok" ? "Done" : "Refused"}</span></td><td class="muted">${d}</td></tr>`).join("")}
      </tbody></table></div>
      <div class="note info" style="margin-top:14px">${ic("shield")}<div>The line at 14:22:55 is the important one: a cross-company read is refused where the data is fetched, not in the screen, and it is recorded whether it came from a person, the Coworker or a stray link. It returns “not found”, which tells an attacker nothing about whether the thing exists.</div></div>`;
    },
  });
})();
