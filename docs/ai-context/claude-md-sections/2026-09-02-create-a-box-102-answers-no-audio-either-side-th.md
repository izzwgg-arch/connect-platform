# ⛔ AGENT HANDOFF — Create A Box 102 "answers, no audio either side": the app's 200 OK never reaches the PBX through the OFFICE TUNNEL (2026-09-02) — READ FIRST for ANY "I answered and it's dead" on a tenant behind a WireGuard peer, before telling him to update the app, or before reading `session_not_found_timeout` as the cause

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CREATEABOX_102_ANSWER_LOST_ON_TUNNEL_2026-09-02.md`**
(**Read-only investigation — no code, no deploy, no PBX write, no data change, no
customer contacted.** Four read-only pcaps left on loopcom in `/root/cab102-cap/`.)
Memory: [[createabox-102-answer-lost-on-the-tunnel]].

- ⛔⛔ **HE IS ON THE FIXED APK (`1.0.0+20260823-175041` since 08-31) AND THIS IS NOT
  THE 08-23 REGRESSION.** Answers happen in ~250 ms and get the full 16 s budget. On
  every app answer this week the blackbox reads `sipAnswer {sent:true, confirmed:false}`,
  candidate **status 6 = WAITING_FOR_ACK**, 16 s, and the PBX log has **no `answered`
  line** — the 16:53Z call rang 30 s to "Nobody picked up" and voicemail while his
  screen showed a connected call. **The 200 OK never arrives at Asterisk.**
- ⛔⛔ **IT IS THE OFFICE WIREGUARD TUNNEL, 0 OF 4 vs 2 OF 2.** All four losses on the
  fixed build (09-01 18:41, 19:37; 09-02 16:40, 16:53) were taken with the contact at
  `45.14.194.179` — the GL.iNet peer 10.88.0.2 on T-Mobile, split-tunnel
  `AllowedIPs 209.145.60.79/32`, so ONLY PBX traffic rides it (nginx sees his HTTPS
  from `172.59.212.134`, the box's own WAN, in the same minute). Both good app calls
  (08-31 19:38 tunnel-down direct, 09-01 14:18 from Optimum) had real RTP. Desk phone
  `T7_102` uses the same tunnel and works all day (SIP/RTP are small packets).
  Fleet the same week: 117 good app answers / 3 lost everywhere else; Create A Box
  1 / 3. **His site, not the platform.**
- ⛔ **"It answers" is the app flipping to `connected` on JsSIP `accepted`
  (`jssip.ts:1696`) — the 200 OK was SENT, not ACKed** — and the app tears the call
  down itself at the 16 s deadline. `failureReason: session_not_found_timeout` is the
  documented lie (the session was found); read `sipAnswer` + candidate status.
- ⚠️ **Cause INFERRED, not proven: a large-packet blackhole on the tunnel's uplink.**
  The 200 OK (SIP + WebRTC SDP, ~1.4–1.6 KB) is the ONE large packet the app sends
  uplink; through the tunnel the phone's SYN is MSS-clamped to **1340** by the GL box,
  so that segment becomes a **1440-byte WireGuard packet on the T-Mobile uplink**;
  WireGuard sets DF and does no PMTUD, so a carrier drop of that size repeats forever,
  while the direct path recovers by ICMP. 18 minutes of captures on loopcom saw **no
  uplink tunnel packet over 1,024 bytes** (nothing else large goes up) and the GL box
  answers no probe on 10.88.0.2 (ping/22/80/83/443 all silent), so the MTU could not be
  measured. Tunnel-path churn is extreme: **313 UNREACHABLE on `T7_102_1` in 48 h**.
- ⛔ **Proof needs ONE test call with a capture running** (handoff §7 C — rings the
  customer, Izzy's call): `tcpdump -ni wg0 -w … "host 10.88.0.2"` + the outer
  `udp port 51820 and host 172.59.212.134` on loopcom, then call (845) 782-6722 → 1.
- ⛔ **Fix candidates, blast radius traced, NONE applied:** (A) move Create A Box's app
  SIP to the **443 route** (`webrtcRouteViaSbc:true, sipWsUrl:null`; `sipDomain` already
  right) — takes the signalling off the tunnel onto the path his HTTPS already uses,
  RTP stays on the tunnel like the desk phones; users must sign out/in. (B) MSS clamp
  on loopcom's `wg0` FORWARD (TCP to the PBX only, 3 peers, desk phones UDP untouched).
  (D) WireGuard MTU 1280 + MSS clamp on the GL box itself. A is cheapest and reversible;
  B/D fix the tunnel only if C proves the hypothesis.
- ✅✅ **OPTION A APPLIED 2026-09-06 15:34Z ON IZZY'S CALL ("the app doesn't need the tunnel at
  all, it works on 5G — the tunnel is only for the hard phones"): Create A Box's app SIP is on
  the 443 route.** Tenant `cmnlgryox001ip9paov24bmr0` `webrtcRouteViaSbc false→true`,
  `sipWsUrl wss://m.connectcomunications.com:8089/ws→null` (guarded `updateMany`, 1 row,
  read back), `sipDomain` already the hostname; backup
  `loopcom:/root/cab102-tenant-backup-20260906T153403Z.json`. No deploy, no PBX write, desk
  phones untouched. ⛔ **WHY the app was on the tunnel at all:** the GL.iNet's split tunnel
  routes *anything addressed to the PBX's IP* through WireGuard for EVERY device on the office
  network, and the app registered directly to that IP — so on office WiFi it was tunnelled
  like a desk phone; on 5G it never was. With `sipWsUrl` null the app is handed the GLOBAL
  `wss://sip.loopcom.net/sip` (loopcom's hostname, never the PBX IP), so the router's rule
  can no longer match it anywhere. ✅ That host is proven by a REAL phone: Hanna (same null
  `sipWsUrl`, no tunnel) registered 9× through it this week; `/sip` answers 101 on all three
  SIP hostnames and 7 phones sat on the 443 route at flip time. ⏳ **NOT PROVEN: Sender has
  not signed out/in yet** — his live contact at 15:37Z was still the tunnel path (PBX port
  48492 is not one of loopcom's nginx→8089 upstream sockets; that is the tell, since both paths
  present `45.14.194.179`). Acceptance: after sign-out/in on office WiFi, his `T7_102_1`
  contact port appears in `ss -tn state established '( dport = :8089 )'` on loopcom, then one
  answered call with audio. ⛔ Interim workaround if he cannot re-login: WiFi off, stay on 5G.
  Reversal: restore the two fields from the backup file.
- ⛔ **Two traps re-earned:** the app's `respondInvite` claim lands 20–25 s after the
  tap on failed calls — that is the app claiming AFTER the answer settles, not network
  lag (the `answer-status` GET at tap time lands instantly); and a failed call's
  `CALL_QUALITY_REPORT` can carry the PREVIOUS call's RTP counters byte-for-byte
  (09-01 18:41 = 14:18's 10998/220/35 ms) — check the counts differ before trusting them.
  `CallInvite` `ACCEPTED`+`endedAt` is the loss marker only since `f17f507a` (08-25);
  older rows read `ACCEPTED` falsely.
