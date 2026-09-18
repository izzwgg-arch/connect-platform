"use client";

import { QRCodeSVG } from "qrcode.react";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { Avatar, Button, useToast } from "@/components/ui";

export default function MyQrPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const { me } = useAuth();
  const toast = useToast();
  if (!me) return null;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}/people/${me.person.username}?via=qr`;
  const name = me.profile ? `${me.profile.firstName} ${me.profile.lastName}` : me.person.username;
  const canShare = typeof navigator !== "undefined" && "share" in navigator;
  return (
    <AppShell cols="narrow" title="My QR code">
      <div className="card" style={{ textAlign: "center", display: "grid", gap: 12, justifyItems: "center" }}>
        <Avatar name={name} assetId={me.profile?.avatarAssetId} size={64} />
        <div>
          <b style={{ fontSize: 16 }}>{name}</b>
          <p className="dim sm">{me.profile?.headline}</p>
        </div>
        <div className="qr">
          <QRCodeSVG value={url} size={220} includeMargin />
        </div>
        <p className="sm dim">Scan → profile, connect, save contact. Works with any camera app.</p>
        <div className="row">
          <Button
            icon="copy"
            onClick={() => {
              void navigator.clipboard?.writeText(url);
              toast("Link copied.");
            }}
          >
            Copy link
          </Button>
          {canShare ? (
            <Button kind="p" icon="share" onClick={() => navigator.share({ title: name, url })}>
              Share
            </Button>
          ) : null}
          <Button href="/scan" icon="qr">Scan a code</Button>
        </div>
      </div>
    </AppShell>
  );
}
