"use client";

import { useEffect, useRef, useState } from "react";
import { api, newIdempotencyKey } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar, Button, Icon, useToast } from "@/components/ui";
import { Uploader, type UploadedAsset } from "@/components/media/Uploader";
import type { PersonCard as PersonCardT, OrgCard as OrgCardT } from "@/components/graph/types";
import type { LinkPreview, Post } from "./types";

/** role presets that carry org.post / org.schedule_posts by default — mirrors organizations/permissions.ts ROLE_PRESETS. */
const ROLE_PRESET_KEYS: Record<string, string[]> = {
  OWNER: ["*"],
  ADMIN: ["*"],
  MANAGER: ["org.post", "org.schedule_posts"],
  MARKETING: ["org.post", "org.schedule_posts"],
};
function membershipCan(m: { role: string; permissions: string[] }, perm: string): boolean {
  const preset = ROLE_PRESET_KEYS[m.role] ?? [];
  return preset.includes("*") || preset.includes(perm) || m.permissions.includes(perm);
}

const VISIBILITY_OPTIONS: Array<{ value: string; label: string; icon: string }> = [
  { value: "PUBLIC", label: "Anyone", icon: "globe" },
  { value: "CONNECTIONS", label: "Connections", icon: "people" },
  { value: "ORGANIZATION", label: "My company", icon: "bldg" },
  { value: "PRIVATE", label: "Only me", icon: "lock" },
];
const COMMENTS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "ANYONE", label: "Anyone can comment" },
  { value: "CONNECTIONS", label: "Connections only" },
  { value: "NOBODY", label: "Comments off" },
];

type Mode = "text" | "media" | "poll";

export function Composer({ onPosted, placeholder = "Share an update, a job, or what you need…", testId = "composer" }: { onPosted?: (post: Post) => void; placeholder?: string; testId?: string }) {
  const { me } = useAuth();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [mode, setMode] = useState<Mode>("text");
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkPreview, setLinkPreview] = useState<LinkPreview | null>(null);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [pollHours, setPollHours] = useState<string>("");
  const [visibility, setVisibility] = useState("PUBLIC");
  const [commentsPolicy, setCommentsPolicy] = useState("ANYONE");
  const [postAsOrgId, setPostAsOrgId] = useState<string>("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [showUploader, setShowUploader] = useState(false);
  const [showPoll, setShowPoll] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  const [mentionQuery, setMentionQuery] = useState<{ start: number; text: string } | null>(null);
  const [suggestions, setSuggestions] = useState<{ people: PersonCardT[]; organizations: OrgCardT[] }>({ people: [], organizations: [] });
  const [mentionMap, setMentionMap] = useState<Map<string, { personId?: string; orgId?: string }>>(new Map());
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const postableOrgs = (me?.memberships ?? []).filter((m) => membershipCan(m, "org.post"));

  useEffect(() => {
    if (!mentionQuery || mentionQuery.text.length < 1) {
      setSuggestions({ people: [], organizations: [] });
      return;
    }
    const t = setTimeout(() => {
      api<{ people: PersonCardT[]; organizations: OrgCardT[] }>(`/search/suggest?q=${encodeURIComponent(mentionQuery.text)}`)
        .then((r) => setSuggestions({ people: r.people ?? [], organizations: r.organizations ?? [] }))
        .catch(() => setSuggestions({ people: [], organizations: [] }));
    }, 200);
    return () => clearTimeout(t);
  }, [mentionQuery]);

  function onBodyChange(value: string, caret: number) {
    setBody(value);
    const upToCaret = value.slice(0, caret);
    const m = /@([\w'-]{1,40})$/.exec(upToCaret);
    if (m) setMentionQuery({ start: caret - m[0].length, text: m[1] });
    else setMentionQuery(null);
  }

  function insertMention(name: string, id: { personId?: string; orgId?: string }) {
    if (!mentionQuery) return;
    const before = body.slice(0, mentionQuery.start);
    const after = body.slice(mentionQuery.start + mentionQuery.text.length + 1);
    const insertText = `@${name}`;
    setBody(`${before}${insertText} ${after}`);
    setMentionMap((cur) => new Map(cur).set(name, id));
    setMentionQuery(null);
    requestAnimationFrame(() => areaRef.current?.focus());
  }

  async function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData("text");
    if (!/^https?:\/\/\S+$/.test(text.trim()) || linkPreview) return;
    const url = text.trim();
    setLinkUrl(url);
    try {
      const r = await api<{ preview: LinkPreview }>("/posts/preview", { method: "POST", body: { url } });
      setLinkPreview(r.preview);
    } catch {
      setLinkUrl(null);
    }
  }

  function resetAll() {
    setBody("");
    setMode("text");
    setAssets([]);
    setLinkUrl(null);
    setLinkPreview(null);
    setPollQuestion("");
    setPollOptions(["", ""]);
    setPollHours("");
    setShowUploader(false);
    setShowPoll(false);
    setShowSchedule(false);
    setScheduledFor("");
    setMentionMap(new Map());
  }

  async function submit() {
    if (busy) return;
    const trimmed = body.trim();
    if (!trimmed && !assets.length && !showPoll && !linkPreview) {
      toast("Write something, add media, a link, or a poll first.", { kind: "err" });
      return;
    }
    if (showPoll) {
      const opts = pollOptions.map((o) => o.trim()).filter(Boolean);
      if (!pollQuestion.trim() || opts.length < 2) {
        toast("A poll needs a question and at least 2 options.", { kind: "err" });
        return;
      }
    }
    setBusy(true);
    try {
      const mentionPersonIds = [...mentionMap.values()].map((v) => v.personId).filter((x): x is string => !!x);
      const mentionOrgIds = [...mentionMap.values()].map((v) => v.orgId).filter((x): x is string => !!x);
      const payload: Record<string, unknown> = {
        body: trimmed || undefined,
        visibility,
        commentsPolicy,
        organizationId: postAsOrgId || undefined,
        mediaAssetIds: assets.length ? assets.map((a) => a.id) : undefined,
        altTexts: assets.length ? assets.map((a) => a.alt || null) : undefined,
        linkUrl: !assets.length && linkUrl ? linkUrl : undefined,
        poll: showPoll
          ? { question: pollQuestion.trim(), options: pollOptions.map((o) => o.trim()).filter(Boolean), closesInHours: pollHours ? Number(pollHours) : undefined }
          : undefined,
        scheduledFor: showSchedule && scheduledFor ? new Date(scheduledFor).toISOString() : undefined,
        mentions: mentionPersonIds.length || mentionOrgIds.length ? { personIds: mentionPersonIds, orgIds: mentionOrgIds } : undefined,
      };
      const r = await api<{ post: Post }>("/posts", { method: "POST", body: payload, idempotencyKey: newIdempotencyKey() });
      resetAll();
      toast(showSchedule && scheduledFor ? "Scheduled." : "Posted.");
      onPosted?.(r.post);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't post that.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  if (!me) return null;
  const fullName = me.profile ? `${me.profile.firstName} ${me.profile.lastName}` : me.person.username;

  return (
    <div className="card" data-testid={testId}>
      <div className="row" style={{ alignItems: "flex-start" }}>
        <Avatar name={fullName} assetId={me.profile?.avatarAssetId} size={40} />
        <div style={{ flex: 1, position: "relative" }} className="composer-mentions">
          <textarea
            ref={areaRef}
            className="in composer-body"
            placeholder={placeholder}
            value={body}
            rows={2}
            onChange={(e) => onBodyChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onPaste={(e) => void onPaste(e)}
            data-testid={`${testId}-body`}
          />
          {mentionQuery && (suggestions.people.length || suggestions.organizations.length) ? (
            <div className="mention-dropdown" data-testid={`${testId}-mentions`}>
              {suggestions.people.map((p) => (
                <button key={p.id} type="button" onClick={() => insertMention(p.name, { personId: p.id })}>
                  <Avatar name={p.name} assetId={p.avatarAssetId} size={22} /> {p.name}
                </button>
              ))}
              {suggestions.organizations.map((o) => (
                <button key={o.id} type="button" onClick={() => insertMention(o.displayName, { orgId: o.id })}>
                  <Avatar name={o.displayName} assetId={o.logoAssetId} size={22} square /> {o.displayName}
                </button>
              ))}
            </div>
          ) : null}

          {linkPreview ? (
            <div className="link-preview" style={{ marginTop: 8 }} data-testid={`${testId}-link-preview`}>
              {linkPreview.image ? <img src={linkPreview.image} alt="" /> : null}
              <div className="lp-body">
                <b>{linkPreview.title ?? linkUrl}</b>
                {linkPreview.description ? <small className="dim">{linkPreview.description}</small> : null}
              </div>
              <Button small kind="g" icon="x" onClick={() => { setLinkPreview(null); setLinkUrl(null); }} data-testid={`${testId}-link-remove`}>
                Remove link
              </Button>
            </div>
          ) : null}

          {showUploader ? (
            <div style={{ marginTop: 8 }}>
              <Uploader accept={["image", "video", "document"]} onChange={setAssets} testId={`${testId}-uploader`} />
            </div>
          ) : null}

          {showPoll ? (
            <div className="composer-preview" data-testid={`${testId}-poll`}>
              <input className="in" placeholder="Ask a question…" value={pollQuestion} onChange={(e) => setPollQuestion(e.target.value)} data-testid={`${testId}-poll-question`} />
              {pollOptions.map((opt, i) => (
                <div className="composer-poll-opt" key={i}>
                  <input
                    className="in"
                    placeholder={`Option ${i + 1}`}
                    value={opt}
                    onChange={(e) => setPollOptions((cur) => cur.map((o, idx) => (idx === i ? e.target.value : o)))}
                    data-testid={`${testId}-poll-option-${i}`}
                  />
                  {pollOptions.length > 2 ? (
                    <button type="button" className="ib" aria-label="Remove option" onClick={() => setPollOptions((cur) => cur.filter((_, idx) => idx !== i))}>
                      <Icon name="x" />
                    </button>
                  ) : null}
                </div>
              ))}
              {pollOptions.length < 6 ? (
                <Button small kind="g" icon="plus" onClick={() => setPollOptions((cur) => [...cur, ""])} data-testid={`${testId}-poll-add-option`}>
                  Add option
                </Button>
              ) : null}
              <div className="field">
                <label className="lbl" htmlFor={`${testId}-poll-hours`}>Closes in (hours, optional)</label>
                <input id={`${testId}-poll-hours`} className="in" type="number" min={1} value={pollHours} onChange={(e) => setPollHours(e.target.value)} data-testid={`${testId}-poll-hours`} />
              </div>
            </div>
          ) : null}

          {showSchedule ? (
            <div className="field" style={{ marginTop: 8 }}>
              <label className="lbl" htmlFor={`${testId}-schedule-at`}>Schedule for</label>
              <input id={`${testId}-schedule-at`} className="in" type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} data-testid={`${testId}-schedule-at`} />
            </div>
          ) : null}

          <div className="row composer-toolbar" style={{ marginTop: 8 }}>
            <Button kind="g" small icon="cam" onClick={() => setShowUploader((s) => !s)} data-testid={`${testId}-toggle-media`}>
              Photo/Video
            </Button>
            <Button kind="g" small icon="doc" onClick={() => setShowUploader((s) => !s)} data-testid={`${testId}-toggle-doc`}>
              Document
            </Button>
            <Button kind="g" small icon="poll" onClick={() => setShowPoll((s) => !s)} data-testid={`${testId}-toggle-poll`}>
              Poll
            </Button>
            <Button kind="g" small icon="cal" onClick={() => setShowSchedule((s) => !s)} data-testid={`${testId}-toggle-schedule`}>
              Schedule
            </Button>
            <span style={{ flex: 1 }} />
            {postableOrgs.length ? (
              <select className="in" style={{ width: 180 }} value={postAsOrgId} onChange={(e) => setPostAsOrgId(e.target.value)} data-testid={`${testId}-post-as`}>
                <option value="">Post as yourself</option>
                {postableOrgs.map((m) => (
                  <option key={m.organization.id} value={m.organization.id}>
                    {m.organization.displayName}
                  </option>
                ))}
              </select>
            ) : null}
            <select className="in" style={{ width: 150 }} value={visibility} onChange={(e) => setVisibility(e.target.value)} data-testid={`${testId}-visibility`} aria-label="Who can see this post">
              {VISIBILITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select className="in" style={{ width: 170 }} value={commentsPolicy} onChange={(e) => setCommentsPolicy(e.target.value)} data-testid={`${testId}-comments-policy`} aria-label="Who can comment">
              {COMMENTS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <Button kind="p" small loading={busy} onClick={() => void submit()} data-testid={`${testId}-submit`}>
              {showSchedule && scheduledFor ? "Schedule" : "Post"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
