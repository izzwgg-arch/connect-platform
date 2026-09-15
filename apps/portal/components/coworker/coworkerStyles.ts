/**
 * The Coworker workspace's styles — the approved mockup (2026-09-15) on the portal's
 * own theme tokens, so it follows light and dark with the rest of Loopcom.
 * Every class is `cw-` so nothing leaks into or out of other screens.
 */
export const COWORKER_STYLES = `
.cw-root { --cw-bg: var(--bg, #0c1218); --cw-panel: var(--panel, #141f2b); --cw-panel-2: var(--panel-2, #1a2635); --cw-panel-3: color-mix(in srgb, var(--panel-2, #1a2635) 70%, var(--border, #26374a));
  --cw-line: var(--border, #26374a); --cw-text: var(--text, #e1e9f1); --cw-muted: var(--text-dim, #8ea0b2); --cw-faint: color-mix(in srgb, var(--text-dim, #8ea0b2) 72%, transparent);
  --cw-accent: var(--accent, #22a8ff); --cw-accent-soft: color-mix(in srgb, var(--accent, #22a8ff) 13%, transparent); --cw-on-accent: #fff;
  --cw-ok: var(--success, #34c27b); --cw-ok-soft: color-mix(in srgb, var(--success, #34c27b) 13%, transparent);
  --cw-warn: var(--warning, #f0b655); --cw-warn-soft: color-mix(in srgb, var(--warning, #f0b655) 15%, transparent); --cw-danger: var(--danger, #ea6068);
  color: var(--cw-text); font-size: 14px; line-height: 1.5; }
.cw-root *, .cw-root *::before, .cw-root *::after { box-sizing: border-box; }
.cw-root button, .cw-root textarea, .cw-root input { font: inherit; color: inherit; }
.cw-root button { cursor: pointer; }
.cw-root :focus-visible { outline: 2px solid var(--cw-accent); outline-offset: 2px; }
.cw-root svg { flex: none; }
.cw-logo { width: 28px; height: 28px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #4fc3ff, #1d6fe0 70%); display: grid; place-items: center; color: #fff; flex: none; overflow: hidden; }
.cw-logo img { width: 100%; height: 100%; object-fit: cover; }
.cw-status { font-size: 12px; color: var(--cw-muted); display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.cw-status i { width: 7px; height: 7px; border-radius: 50%; background: var(--cw-ok); display: block; }
.cw-status.busy i { background: var(--cw-warn); animation: cw-pulse 1.2s infinite; }
.cw-status.off i { background: var(--cw-faint); }
@keyframes cw-pulse { 50% { transform: scale(1.25); opacity: .6; } }
.cw-icon-btn { width: 30px; height: 30px; border-radius: 8px; border: 0; background: transparent; color: var(--cw-muted); display: grid; place-items: center; }
.cw-icon-btn:hover { background: var(--cw-panel-2); color: var(--cw-text); }
.cw-icon-btn:disabled { opacity: .4; cursor: default; }

/* ── chat list ── */
.cw-chat { flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.cw-empty { margin: auto 0; display: grid; gap: 12px; }
.cw-empty h3 { margin: 0; font-size: 17px; letter-spacing: -.01em; }
.cw-empty p { margin: 0; color: var(--cw-muted); font-size: 13px; }
.cw-suggest { display: grid; gap: 8px; }
.cw-suggest button { text-align: left; border: 1px solid var(--cw-line); background: var(--cw-panel-2); border-radius: 10px; padding: 9px 12px; font-size: 13px; display: flex; gap: 10px; align-items: center; }
.cw-suggest button:hover { border-color: var(--cw-accent); background: var(--cw-accent-soft); }
.cw-suggest button svg { color: var(--cw-accent); }
.cw-msg-user { align-self: flex-end; max-width: 85%; background: var(--cw-accent); color: var(--cw-on-accent); padding: 9px 13px; border-radius: 14px 14px 4px 14px; font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.cw-msg-user .cw-attached { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.cw-msg-user .cw-attached span { font-size: 11px; background: rgba(255,255,255,.18); border-radius: 6px; padding: 1px 6px; display: inline-flex; gap: 4px; align-items: center; }
.cw-msg-ai { display: flex; gap: 10px; align-items: flex-start; }
.cw-msg-ai > .cw-logo { width: 24px; height: 24px; margin-top: 1px; }
.cw-msg-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.cw-text { font-size: 13.5px; overflow-wrap: anywhere; }
.cw-text p { margin: 0 0 6px; }
.cw-text ul, .cw-text ol { margin: 4px 0 6px; padding-left: 18px; }
.cw-text li { margin: 2px 0; }
.cw-degraded { font-size: 12px; color: var(--cw-warn); }

/* ── the live steps block (the "IDE" part) ── */
.cw-steps { display: flex; flex-direction: column; border: 1px solid var(--cw-line); border-radius: 10px; background: var(--cw-panel-2); overflow: hidden; }
.cw-steps-h { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 11.5px; color: var(--cw-muted); border-bottom: 1px solid var(--cw-line); letter-spacing: .02em; }
.cw-steps-h b { color: var(--cw-text); font-weight: 600; }
.cw-steps-h .cw-timer { margin-left: auto; font-variant-numeric: tabular-nums; }
.cw-steps-h button { border: 0; background: none; color: var(--cw-muted); font-size: 11.5px; padding: 0 2px; }
.cw-step { border-top: 1px solid var(--cw-line); }
.cw-step:first-of-type { border-top: 0; }
.cw-step-row { width: 100%; display: flex; align-items: center; gap: 9px; padding: 7px 10px; border: 0; background: transparent; text-align: left; font-size: 12.5px; }
.cw-step-row:hover { background: var(--cw-panel-3); }
.cw-tool { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--cw-accent); background: var(--cw-accent-soft); padding: 1px 7px 1px 5px; border-radius: 99px; white-space: nowrap; }
.cw-step-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-step.running .cw-step-label { background: linear-gradient(90deg, var(--cw-text) 30%, var(--cw-faint) 50%, var(--cw-text) 70%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent; animation: cw-shimmer 1.6s linear infinite; }
@keyframes cw-shimmer { to { background-position: -200% 0; } }
.cw-step-state { font-size: 11px; color: var(--cw-faint); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cw-ok { color: var(--cw-ok); } .cw-wait { color: var(--cw-warn); } .cw-bad { color: var(--cw-danger); } .cw-mute { color: var(--cw-faint); }
.cw-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--cw-line); border-top-color: var(--cw-accent); animation: cw-spin .8s linear infinite; flex: none; display: inline-block; }
@keyframes cw-spin { to { transform: rotate(360deg); } }
.cw-spinning { animation: cw-spin .8s linear infinite; }
.cw-chev { color: var(--cw-faint); transition: transform .15s; display: inline-flex; }
.cw-step.open .cw-chev { transform: rotate(90deg); }
.cw-step-detail { display: none; padding: 2px 12px 9px 33px; font-size: 12px; color: var(--cw-muted); }
.cw-step.open .cw-step-detail { display: block; }
.cw-step-detail ul { margin: 0; padding-left: 16px; }
.cw-thinking { display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 12.5px; color: var(--cw-muted); border-top: 1px solid var(--cw-line); }
.cw-steps-h + .cw-thinking { border-top: 0; }

.cw-approve { border: 1px solid var(--cw-warn); background: var(--cw-warn-soft); border-radius: 10px; padding: 10px 12px; display: grid; gap: 8px; }
.cw-approve-h { display: flex; gap: 8px; align-items: center; font-size: 12px; font-weight: 600; color: var(--cw-warn); }
.cw-approve p { margin: 0; font-size: 13px; }
.cw-approve small { color: var(--cw-muted); font-size: 12px; }
.cw-approve .cw-row { display: flex; gap: 8px; flex-wrap: wrap; }
.cw-question-input { display: flex; gap: 6px; }
.cw-question-input input { flex: 1; min-width: 0; border: 1px solid var(--cw-line); background: var(--cw-panel); border-radius: 8px; padding: 6px 10px; font-size: 13px; outline: none; }
.cw-question-input input:focus { border-color: var(--cw-accent); }
.cw-btn { border: 1px solid var(--cw-line); background: var(--cw-panel); border-radius: 8px; padding: 6px 12px; font-weight: 600; font-size: 12.5px; }
.cw-btn:hover { border-color: var(--cw-faint); }
.cw-btn:disabled { opacity: .5; cursor: default; }
.cw-btn.primary { background: var(--cw-accent); border-color: var(--cw-accent); color: var(--cw-on-accent); }
.cw-btn.primary:hover { filter: brightness(1.07); }
.cw-btn.danger { color: var(--cw-danger); }
.cw-answered { font-size: 12px; color: var(--cw-muted); display: flex; gap: 6px; align-items: center; }
.cw-typing { display: flex; gap: 4px; padding: 6px 0; }
.cw-typing i { width: 6px; height: 6px; border-radius: 50%; background: var(--cw-faint); animation: cw-bob 1s infinite; display: block; }
.cw-typing i:nth-child(2) { animation-delay: .15s; } .cw-typing i:nth-child(3) { animation-delay: .3s; }
@keyframes cw-bob { 50% { transform: translateY(-4px); opacity: .5; } }
.cw-error { font-size: 12.5px; color: var(--cw-danger); background: color-mix(in srgb, var(--cw-danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--cw-danger) 35%, transparent); border-radius: 8px; padding: 7px 10px; }
.cw-notice { font-size: 12px; color: var(--cw-muted); background: var(--cw-panel-2); border: 1px dashed var(--cw-line); border-radius: 8px; padding: 7px 10px; }

/* ── composer ── */
.cw-composer { padding: 10px; border-top: 1px solid var(--cw-line); position: relative; }
.cw-cbox { border: 1px solid var(--cw-line); border-radius: 12px; background: var(--cw-panel-2); padding: 8px 8px 6px 12px; display: grid; gap: 4px; }
.cw-cbox:focus-within { border-color: var(--cw-accent); }
.cw-cbox.drop { border-color: var(--cw-accent); background: var(--cw-accent-soft); }
.cw-cbox textarea { border: 0; background: transparent; resize: none; outline: none; min-height: 40px; max-height: 160px; font-size: 13.5px; }
.cw-cbar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.cw-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--cw-muted); border: 1px solid var(--cw-line); border-radius: 99px; padding: 2px 9px; background: var(--cw-panel); white-space: nowrap; }
.cw-chip svg { color: var(--cw-ok); }
.cw-chip.full svg { color: var(--cw-warn); }
.cw-chip.button:hover { border-color: var(--cw-faint); color: var(--cw-text); }
.cw-send { margin-left: auto; width: 32px; height: 32px; border-radius: 9px; border: 0; background: var(--cw-accent); color: var(--cw-on-accent); display: grid; place-items: center; }
.cw-send.stop { background: var(--cw-text); color: var(--cw-bg); }
.cw-send:disabled { opacity: .4; cursor: default; }
.cw-mic.on { color: var(--cw-danger); background: color-mix(in srgb, var(--cw-danger) 12%, transparent); }
.cw-cnote { font-size: 11px; color: var(--cw-faint); text-align: center; margin-top: 6px; }
.cw-pending { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-pchip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--cw-line); background: var(--cw-panel); border-radius: 8px; padding: 3px 4px 3px 8px; font-size: 12px; max-width: 100%; position: relative; overflow: hidden; }
.cw-pchip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.cw-pchip.err { border-color: var(--cw-danger); color: var(--cw-danger); }
.cw-pchip.folder svg, .cw-pchip.repo svg { color: var(--cw-accent); }
.cw-pchip .cw-bar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--cw-accent); transition: width .2s; }
.cw-pchip button { border: 0; background: none; color: var(--cw-faint); display: grid; place-items: center; padding: 1px; border-radius: 4px; }
.cw-pchip button:hover { color: var(--cw-text); background: var(--cw-panel-2); }
.cw-menu { position: absolute; bottom: calc(100% - 4px); left: 10px; z-index: 30; background: var(--cw-panel); border: 1px solid var(--cw-line); border-radius: 10px; box-shadow: 0 12px 30px rgba(0,0,0,.28); padding: 6px; display: grid; gap: 2px; min-width: 250px; }
.cw-menu button { display: flex; gap: 10px; align-items: flex-start; text-align: left; border: 0; background: transparent; border-radius: 7px; padding: 7px 9px; font-size: 13px; }
.cw-menu button:hover:not(:disabled) { background: var(--cw-panel-2); }
.cw-menu button:disabled { opacity: .45; cursor: default; }
.cw-menu button small { display: block; color: var(--cw-muted); font-size: 11.5px; }
.cw-menu button svg { margin-top: 2px; color: var(--cw-accent); }
.cw-menu .on { background: var(--cw-accent-soft); }
.cw-rec { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--cw-danger); padding: 2px 0; }
.cw-rec i { width: 8px; height: 8px; border-radius: 50%; background: var(--cw-danger); animation: cw-pulse 1s infinite; display: block; }
.cw-dropzone { position: absolute; inset: 0; z-index: 25; border: 2px dashed var(--cw-accent); border-radius: 14px; background: color-mix(in srgb, var(--cw-accent) 10%, var(--cw-panel)); display: grid; place-items: center; text-align: center; font-weight: 600; color: var(--cw-accent); pointer-events: none; }
.cw-dropzone small { display: block; font-weight: 400; color: var(--cw-muted); }

/* ── bubble popover ── */
.cw-popover { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--cw-panel); overflow: hidden; }
.cw-whead { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-bottom: 1px solid var(--cw-line); -webkit-app-region: drag; user-select: none; }
.cw-whead button { -webkit-app-region: no-drag; }
.cw-wtitle { flex: 1; min-width: 0; }
.cw-wtitle b { display: block; font-size: 14px; line-height: 1.2; }

/* ── full page ── */
.cw-app { height: calc(100vh - 118px); min-height: 560px; border: 1px solid var(--cw-line); border-radius: 14px; overflow: hidden; background: var(--cw-bg); display: grid; grid-template-columns: 250px minmax(0, 1fr) 300px; }
.cw-app.settings { grid-template-columns: 250px minmax(0, 1fr); }
.cw-rail { background: var(--cw-panel); border-right: 1px solid var(--cw-line); display: flex; flex-direction: column; min-height: 0; }
.cw-rail-top { padding: 12px; display: grid; gap: 10px; }
.cw-brand { display: flex; align-items: center; gap: 9px; font-weight: 700; }
.cw-brand small { display: block; font-weight: 500; color: var(--cw-muted); font-size: 11.5px; }
.cw-newtask { display: flex; align-items: center; gap: 8px; justify-content: center; border: 0; background: var(--cw-accent); color: var(--cw-on-accent); border-radius: 9px; padding: 8px; font-weight: 600; font-size: 13px; }
.cw-search { display: flex; align-items: center; gap: 8px; border: 1px solid var(--cw-line); background: var(--cw-panel-2); border-radius: 9px; padding: 6px 10px; color: var(--cw-faint); font-size: 13px; }
.cw-search input { border: 0; background: transparent; outline: none; flex: 1; min-width: 0; color: var(--cw-text); }
.cw-tasks { flex: 1; overflow-y: auto; padding: 4px 8px; }
.cw-group { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--cw-faint); font-weight: 600; padding: 12px 8px 4px; }
.cw-task { width: 100%; border: 0; background: transparent; text-align: left; border-radius: 8px; padding: 7px 8px; display: flex; gap: 8px; align-items: center; font-size: 13px; }
.cw-task:hover { background: var(--cw-panel-2); }
.cw-task[aria-current="true"] { background: var(--cw-accent-soft); }
.cw-task span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-task .cw-spin { width: 12px; height: 12px; }
.cw-rail-nav { border-top: 1px solid var(--cw-line); padding: 8px; display: grid; gap: 2px; }
.cw-rail-nav button { border: 0; background: transparent; border-radius: 8px; padding: 7px 8px; display: flex; gap: 9px; align-items: center; font-size: 13px; color: var(--cw-muted); text-align: left; }
.cw-rail-nav button:hover { background: var(--cw-panel-2); color: var(--cw-text); }
.cw-rail-nav button[aria-current="true"] { background: var(--cw-panel-2); color: var(--cw-text); font-weight: 600; }
.cw-center { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--cw-bg); }
.cw-chead { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid var(--cw-line); background: var(--cw-panel); }
.cw-chead h2 { margin: 0; font-size: 15px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-center .cw-chat { padding: 22px max(20px, calc((100% - 760px) / 2)); }
.cw-center .cw-composer { padding: 12px max(20px, calc((100% - 760px) / 2)) 14px; border-top: 0; }
.cw-center .cw-menu { left: max(20px, calc((100% - 760px) / 2)); }
.cw-center .cw-msg-user { max-width: 70%; }
.cw-inspector { background: var(--cw-panel); border-left: 1px solid var(--cw-line); overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 18px; min-height: 0; }
.cw-isec h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--cw-faint); }
.cw-plan { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.cw-plan li { display: flex; gap: 9px; align-items: flex-start; font-size: 12.5px; padding: 5px 0; }
.cw-plan .cw-pd { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--cw-line); margin-top: 2px; flex: none; }
.cw-plan li.done { color: var(--cw-muted); }
.cw-plan li.done .cw-pd { border: 0; background: var(--cw-ok); box-shadow: inset 0 0 0 3px var(--cw-panel); }
.cw-plan li.now { font-weight: 600; }
.cw-plan li.now .cw-pd { border-top-color: var(--cw-accent); animation: cw-spin .8s linear infinite; }
.cw-plan li.wait .cw-pd { border-color: var(--cw-warn); animation: none; }
.cw-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 12.5px; margin: 0; }
.cw-kv dt { color: var(--cw-muted); } .cw-kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.cw-live { border: 1px solid var(--cw-line); border-radius: 10px; overflow: hidden; background: var(--cw-panel-2); }
.cw-live-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--cw-line); font-size: 11px; color: var(--cw-muted); }
.cw-live-bar i { width: 7px; height: 7px; border-radius: 50%; background: var(--cw-line); display: block; }
.cw-live-bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.cw-live-body { padding: 10px; display: grid; gap: 6px; font-size: 12px; color: var(--cw-muted); min-height: 96px; align-content: start; }
.cw-live-body .cw-live-title { display: flex; gap: 8px; align-items: center; color: var(--cw-text); font-weight: 600; font-size: 12.5px; overflow-wrap: anywhere; }
.cw-live-body .cw-live-title svg { color: var(--cw-accent); }
.cw-live-recent { display: grid; gap: 3px; }
.cw-live-recent div { display: flex; gap: 6px; align-items: center; overflow: hidden; }
.cw-live-recent div span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-ilist { display: grid; gap: 6px; }
.cw-file-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--cw-line); background: var(--cw-panel); border-radius: 8px; padding: 5px 9px; font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }
.cw-file-chip svg { color: var(--cw-ok); }
.cw-stopall { border: 1px solid var(--cw-line); background: var(--cw-panel); color: var(--cw-danger); border-radius: 9px; padding: 8px; font-weight: 600; font-size: 12.5px; display: flex; gap: 8px; align-items: center; justify-content: center; }
.cw-stopall:disabled { opacity: .45; cursor: default; }

/* ── settings / activity ── */
.cw-settings { overflow-y: auto; padding: 24px max(24px, calc((100% - 760px) / 2)) 40px; display: flex; flex-direction: column; gap: 22px; min-height: 0; }
.cw-settings h2 { margin: 0; font-size: 20px; letter-spacing: -.01em; }
.cw-lede { margin: 4px 0 0; color: var(--cw-muted); max-width: 62ch; }
.cw-card { background: var(--cw-panel); border: 1px solid var(--cw-line); border-radius: 12px; padding: 16px; display: grid; gap: 12px; }
.cw-card h3 { margin: 0; font-size: 14px; }
.cw-card > p { margin: -6px 0 0; color: var(--cw-muted); font-size: 12.5px; }
.cw-choice { display: flex; gap: 12px; align-items: flex-start; border: 1px solid var(--cw-line); border-radius: 10px; padding: 10px 12px; cursor: pointer; }
.cw-choice.on { border-color: var(--cw-accent); background: var(--cw-accent-soft); }
.cw-choice.disabled { cursor: default; opacity: .6; }
.cw-choice input { margin-top: 3px; accent-color: var(--cw-accent); }
.cw-choice b { display: block; font-size: 13px; }
.cw-choice span { font-size: 12.5px; color: var(--cw-muted); }
.cw-trow { display: flex; gap: 12px; align-items: center; padding: 8px 0; border-top: 1px solid var(--cw-line); }
.cw-trow:first-of-type { border-top: 0; }
.cw-trow .cw-ti { width: 32px; height: 32px; border-radius: 8px; background: var(--cw-panel-2); display: grid; place-items: center; color: var(--cw-accent); flex: none; }
.cw-trow > div { flex: 1; min-width: 0; }
.cw-trow b { display: block; font-size: 13px; }
.cw-trow span { font-size: 12px; color: var(--cw-muted); }
.cw-switch { position: relative; width: 38px; height: 22px; flex: none; }
.cw-switch input { opacity: 0; position: absolute; inset: 0; margin: 0; cursor: pointer; z-index: 1; }
.cw-switch input:disabled { cursor: default; }
.cw-switch i { position: absolute; inset: 0; border-radius: 99px; background: var(--cw-panel-3); border: 1px solid var(--cw-line); transition: .15s; display: block; }
.cw-switch i::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: .15s; }
.cw-switch input:checked + i { background: var(--cw-accent); border-color: var(--cw-accent); }
.cw-switch input:checked + i::after { left: 18px; }
.cw-switch input:disabled + i { opacity: .5; }
.cw-never { display: flex; flex-wrap: wrap; gap: 6px; }
.cw-never span { font-size: 12px; border: 1px solid var(--cw-line); border-radius: 99px; padding: 3px 10px; background: var(--cw-panel-2); color: var(--cw-muted); }
.cw-settings textarea { width: 100%; min-height: 90px; border: 1px solid var(--cw-line); background: var(--cw-panel-2); border-radius: 10px; padding: 10px 12px; resize: vertical; outline: none; font-size: 13px; color: var(--cw-text); }
.cw-settings textarea:focus { border-color: var(--cw-accent); }
.cw-saverow { display: flex; align-items: center; gap: 10px; justify-content: flex-end; font-size: 12px; color: var(--cw-muted); }
.cw-log { display: grid; }
.cw-log > div { display: grid; grid-template-columns: 74px 1fr auto; gap: 10px; padding: 8px 0; border-top: 1px solid var(--cw-line); font-size: 12.5px; align-items: center; }
.cw-log > div:first-child { border-top: 0; }
.cw-log time { color: var(--cw-faint); font-variant-numeric: tabular-nums; }
.cw-pill { font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 99px; white-space: nowrap; }
.cw-pill.ok { color: var(--cw-ok); background: var(--cw-ok-soft); }
.cw-pill.ask { color: var(--cw-warn); background: var(--cw-warn-soft); }
.cw-pill.no { color: var(--cw-danger); background: color-mix(in srgb, var(--cw-danger) 12%, transparent); }
.cw-folders { display: grid; gap: 6px; }
.cw-folder { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border: 1px solid var(--cw-line); border-radius: 8px; padding: 6px 8px; background: var(--cw-panel-2); }
.cw-folder span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-folder svg { color: var(--cw-accent); }

@media (max-width: 1100px) { .cw-app { grid-template-columns: 220px minmax(0, 1fr); } .cw-inspector { display: none; } }
@media (max-width: 760px) { .cw-app, .cw-app.settings { grid-template-columns: minmax(0, 1fr); height: calc(100vh - 90px); } .cw-rail { display: none; } }
@media (prefers-reduced-motion: reduce) { .cw-root *, .cw-root *::before, .cw-root *::after { animation-duration: 0s !important; transition: none !important; } }
`;
