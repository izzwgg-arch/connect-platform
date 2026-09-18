"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Avatar, Button, Icon, VChip, useToast } from "@/components/ui";
import { ReportDialog } from "@/components/graph/ReportDialog";
import type { ThreadDetail } from "./types";

export function ThreadInfo({ threadId, version }: { threadId: string; version: number }) {
  const { me } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<ThreadDetail>(`/threads/${threadId}`).then((d) => !cancelled && setDetail(d));
    return () => {
      cancelled = true;
    };
    // `version` bumps whenever the parent knows the thread's state changed (mute/pin/archive/accept).
  }, [threadId, version]);

  if (!detail) return null;
  const other = detail.kind === "DIRECT" ? detail.participants.find((p) => p.person.id !== me?.person.id) : null;

  async function act(path: string, method: "POST" | "DELETE" = "POST") {
    try {
      await api(`/threads/${threadId}/${path}`, { method });
      toast("Done.");
    } catch (err) {
      toast((err as Error).message, { kind: "err" });
    }
  }

  return (
    <div className="msg-pane-info" data-testid="messages-info">
      {detail.kind === "DIRECT" && other ? (
        <div className="msg-info-who">
          <Avatar name={other.person.name} assetId={other.person.avatarAssetId} size={56} />
          <b>{other.person.name}</b>
          <small className="dim">{other.state === "ACTIVE" ? "Connected" : other.state === "REQUESTED" ? "Message request pending" : ""}</small>
          <div className="pill-row" style={{ justifyContent: "center", marginTop: 6 }}>
            {other.person.verified.length ? <VChip>{other.person.verified[0].replace(/_/g, " ").toLowerCase()}</VChip> : null}
          </div>
          <div style={{ marginTop: 8 }}>
            <Link href={`/people/${other.person.username}`} className="btn g s" data-testid="messages-info-view-profile">
              View profile
            </Link>
          </div>
        </div>
      ) : (
        <div className="msg-info-who">
          <b>{detail.title}</b>
          <small className="dim">{detail.participants.length} people</small>
        </div>
      )}

      {detail.ref ? (
        <div>
          <span className="lbl">From</span>
          <div className="embed">
            <span className="k">{detail.ref.type}</span>
            <b>Linked {detail.ref.type.toLowerCase()}</b>
            <div className="row">
              <Link className="btn s" href={`/${detail.ref.type.toLowerCase()}/${detail.ref.id}`}>
                View
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      {detail.sharedFiles.length ? (
        <div className="msg-files">
          <span className="lbl">Shared files</span>
          <div className="list sm">
            {detail.sharedFiles.map((f) => (
              <a key={f.id} className="li" href={f.url} target="_blank" rel="noreferrer">
                <Icon name={f.kind === "image" ? "image" : "doc"} />
                <div className="t">
                  <b>{f.name ?? f.kind}</b>
                </div>
              </a>
            ))}
          </div>
        </div>
      ) : null}

      <div className="row">
        <Button kind="g" small onClick={() => void act("mute")} data-testid="messages-info-mute">
          Mute
        </Button>
        <Button kind="g" small onClick={() => void act("pin")} data-testid="messages-info-pin">
          Pin
        </Button>
        <Button kind="g" small onClick={() => void act("archive")} data-testid="messages-info-archive">
          Archive
        </Button>
        {detail.kind === "DIRECT" && other ? (
          <Button kind="g d" small onClick={() => setReportOpen(true)} data-testid="messages-info-report">
            Report
          </Button>
        ) : null}
      </div>
      {detail.kind === "GROUP" ? (
        <Button kind="g d" small onClick={() => void act("leave")} data-testid="messages-info-leave">
          Leave group
        </Button>
      ) : null}

      {detail.kind === "DIRECT" && other ? <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} targetType="person" targetId={other.person.id} testId="messages-report" /> : null}
    </div>
  );
}
