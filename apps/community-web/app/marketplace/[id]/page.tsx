"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError, trackEvent } from "@/lib/api";
import { Avatar, Button, Chip, Dialog, Empty, Icon, Skeleton, useToast } from "@/components/ui";
import { priceLabel, type ListingItem } from "@/components/marketplace/ListingCard";
import "@/components/marketplace/marketplace.css";

export default function ListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [item, setItem] = useState<ListingItem | null>(null);
  const [notFoundFlag, setNotFoundFlag] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageBody, setMessageBody] = useState("");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAvailability, setEditAvailability] = useState("AVAILABLE");
  const [savingEdit, setSavingEdit] = useState(false);

  useEffect(() => {
    api<ListingItem>(`/public/listings/${id}`)
      .then((r) => {
        setItem(r);
        trackEvent("post_impression", { objectType: "Listing", objectId: id, surface: "marketplace_detail" });
      })
      .catch(() => setNotFoundFlag(true));
  }, [id]);

  async function toggleSave() {
    if (!item) return;
    if (!me) {
      router.push(`/login?next=/marketplace/${id}`);
      return;
    }
    setSaving(true);
    const next = !item.saved;
    setItem({ ...item, saved: next });
    try {
      await api(`/listings/${id}/save`, { method: next ? "POST" : "DELETE" });
    } catch (e: any) {
      setItem((cur) => (cur ? { ...cur, saved: !next } : cur));
      toast(e?.message ?? "Couldn't save that.", { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  async function sendMessage() {
    if (!messageBody.trim()) return;
    setSending(true);
    try {
      await api(`/listings/${id}/message`, { method: "POST", body: { body: messageBody.trim() } });
      toast("Message sent.");
      setMessageOpen(false);
      setMessageBody("");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send that message.", { kind: "err" });
    } finally {
      setSending(false);
    }
  }

  async function share() {
    const url = `${window.location.origin}/marketplace/${id}`;
    try {
      if (navigator.share) await navigator.share({ title: item?.listing.title, url });
      else {
        await navigator.clipboard.writeText(url);
        toast("Link copied.");
      }
    } catch {
      /* share cancelled */
    }
  }

  async function submitReport(reason: string) {
    try {
      await api("/reports", { method: "POST", body: { targetType: "listing", targetId: id, reason } });
      toast("Thanks — we'll take a look.");
      setReportOpen(false);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't send that report.", { kind: "err" });
    }
  }

  function openEdit() {
    if (!item) return;
    setEditTitle(item.listing.title);
    setEditDescription(item.listing.description);
    setEditAvailability(item.listing.availability);
    setEditOpen(true);
  }

  async function saveEdit() {
    if (!editTitle.trim() || !editDescription.trim()) return;
    setSavingEdit(true);
    try {
      const updated = await api<ListingItem>(`/listings/${id}`, { method: "PATCH", body: { title: editTitle.trim(), description: editDescription.trim(), availability: editAvailability } });
      setItem(updated);
      toast("Listing updated.");
      setEditOpen(false);
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't update that listing.", { kind: "err" });
    } finally {
      setSavingEdit(false);
    }
  }

  async function remove() {
    try {
      await api(`/listings/${id}`, { method: "DELETE" });
      toast("Listing removed.");
      router.push("/marketplace");
    } catch (err) {
      toast((err as ApiError).message ?? "Couldn't remove that listing.", { kind: "err" });
    }
  }

  const isOwner = !!me && !!item && (item.seller.person?.id === me.person.id || (item.seller.organization && me.memberships.some((m) => m.organization.id === item.seller.organization!.id)));

  const body = notFoundFlag ? (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <Empty title="That listing doesn't exist" text="It may have been removed or the link is wrong." action={<Button href="/marketplace">Back to marketplace</Button>} />
    </div>
  ) : !item ? (
    <div className="col" style={{ gridColumn: "1/-1" }}>
      <Skeleton h={260} />
    </div>
  ) : (
    <div className="col" style={{ gridColumn: "1/-1" }} data-testid="marketplace-detail">
      <div className="card">
        {item.media.length ? (
          <div className="mkt-gallery" data-testid="marketplace-detail-gallery">
            {item.media.map((m) => (
              <img key={m.id} src={m.url} alt="" />
            ))}
          </div>
        ) : null}
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <h1 style={{ fontSize: 20 }}>{item.listing.title}</h1>
            <div className="row xs dim" style={{ marginTop: 6 }}>
              <Avatar name={item.seller.organization?.displayName ?? item.seller.person?.name ?? "Seller"} assetId={item.seller.organization?.logoAssetId ?? item.seller.person?.avatarAssetId ?? null} size={28} />
              {item.seller.organization ? (
                <Link href={`/companies/${item.seller.organization.slug}`}>{item.seller.organization.displayName}</Link>
              ) : item.seller.person ? (
                <Link href={`/people/${item.seller.person.username}`}>{item.seller.person.name}</Link>
              ) : (
                <span>Unknown seller</span>
              )}
              {item.verified ? <Chip kind="ok" icon="check">verified</Chip> : <Chip kind="warn">unverified</Chip>}
            </div>
          </div>
          <b className="mono" style={{ color: "var(--accent)", fontSize: 18 }}>
            {priceLabel(item.listing)}
          </b>
        </div>

        <p className="sm" style={{ marginTop: 12, whiteSpace: "pre-wrap" }}>
          {item.listing.description}
        </p>

        <div className="grid3" style={{ marginTop: 12 }}>
          {item.listing.minimumOrder ? (
            <div className="card tight" style={{ background: "var(--bg-soft)" }}>
              <small className="lbl" style={{ margin: 0 }}>Minimum order</small>
              <b className="sm">{item.listing.minimumOrder}</b>
            </div>
          ) : null}
          {item.listing.turnaround ? (
            <div className="card tight" style={{ background: "var(--bg-soft)" }}>
              <small className="lbl" style={{ margin: 0 }}>Turnaround</small>
              <b className="sm">{item.listing.turnaround}</b>
            </div>
          ) : null}
          {item.listing.delivery ? (
            <div className="card tight" style={{ background: "var(--bg-soft)" }}>
              <small className="lbl" style={{ margin: 0 }}>Delivery</small>
              <b className="sm">{item.listing.delivery}</b>
            </div>
          ) : null}
          <div className="card tight" style={{ background: "var(--bg-soft)" }}>
            <small className="lbl" style={{ margin: 0 }}>Availability</small>
            <b className="sm">{item.listing.availability === "AVAILABLE" ? "Available" : item.listing.availability === "LIMITED" ? "Limited availability" : "Sold out"}</b>
          </div>
        </div>

        {item.listing.serviceArea.length ? (
          <div className="mkt-service-area">
            {item.listing.serviceArea.map((a) => (
              <Chip key={a} icon="pin">
                {a}
              </Chip>
            ))}
          </div>
        ) : null}

        <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
          <Button
            kind="p"
            href={`/rfq/new?vendor=${encodeURIComponent(item.seller.organization?.id ?? item.seller.person?.id ?? "")}&listing=${encodeURIComponent(item.listing.id)}`}
            data-testid="marketplace-detail-quote"
          >
            Request quote
          </Button>
          {me ? (
            <Button onClick={() => setMessageOpen(true)} data-testid="marketplace-detail-message">
              Message seller
            </Button>
          ) : (
            <Button href={`/login?next=/marketplace/${id}`} data-testid="marketplace-detail-signin-message">
              Sign in to message
            </Button>
          )}
          <Button kind="g" icon="save" loading={saving} onClick={toggleSave} data-testid="marketplace-detail-save">
            {item.saved ? "Saved" : "Save"}
          </Button>
          <Button kind="g" icon="share" onClick={share} data-testid="marketplace-detail-share">
            Share
          </Button>
          {me && !isOwner ? (
            <Button kind="g" icon="flag" onClick={() => setReportOpen(true)} data-testid="marketplace-detail-report">
              Report
            </Button>
          ) : null}
          {isOwner ? (
            <>
              <Button kind="g" icon="edit" onClick={openEdit} data-testid="marketplace-detail-edit">
                Edit
              </Button>
              <Button kind="g d" icon="trash" onClick={() => setRemoveOpen(true)} data-testid="marketplace-detail-remove">
                Remove
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <Dialog open={messageOpen} onClose={() => setMessageOpen(false)} title="Message the seller">
        <textarea
          className="in"
          style={{ minHeight: 100, marginTop: 10 }}
          placeholder="Ask about pricing, timing, or anything else…"
          value={messageBody}
          onChange={(e) => setMessageBody(e.target.value)}
          data-testid="marketplace-detail-message-body"
        />
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <Button kind="p" loading={sending} disabled={!messageBody.trim()} onClick={sendMessage} data-testid="marketplace-detail-message-send">
            Send
          </Button>
        </div>
      </Dialog>

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit listing" wide>
        <div className="field">
          <label className="lbl" htmlFor="mkt-edit-title">Title</label>
          <input id="mkt-edit-title" className="in" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={160} data-testid="marketplace-edit-title" />
        </div>
        <div className="field">
          <label className="lbl" htmlFor="mkt-edit-desc">Description</label>
          <textarea id="mkt-edit-desc" className="in" style={{ minHeight: 100 }} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} maxLength={8000} data-testid="marketplace-edit-description" />
        </div>
        <div className="field">
          <label className="lbl" htmlFor="mkt-edit-avail">Availability</label>
          <select id="mkt-edit-avail" className="in" value={editAvailability} onChange={(e) => setEditAvailability(e.target.value)} data-testid="marketplace-edit-availability">
            <option value="AVAILABLE">Available</option>
            <option value="LIMITED">Limited availability</option>
            <option value="SOLD_OUT">Sold out</option>
          </select>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 10 }}>
          <Button kind="p" loading={savingEdit} onClick={saveEdit} data-testid="marketplace-edit-save">
            Save changes
          </Button>
        </div>
      </Dialog>

      <Dialog open={reportOpen} onClose={() => setReportOpen(false)} title="Report this listing">
        <div className="list sm">
          {["SPAM", "SCAM", "FAKE_COMPANY", "OTHER"].map((r) => (
            <button key={r} type="button" className="li" style={{ width: "100%", textAlign: "left", cursor: "pointer" }} onClick={() => submitReport(r)} data-testid={`marketplace-detail-report-${r.toLowerCase()}`}>
              <div className="t">
                <b>{r.replace("_", " ")}</b>
              </div>
            </button>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title="Remove this listing?"
        footer={
          <>
            <Button kind="g" onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button kind="d" onClick={remove} data-testid="marketplace-detail-remove-confirm">
              Remove
            </Button>
          </>
        }
      >
        <p className="sm">Buyers will no longer be able to find or message about this listing.</p>
      </Dialog>
    </div>
  );

  if (me) {
    return <AppShell title={item?.listing.title ?? "Listing"}>{body}</AppShell>;
  }
  return (
    <div className="land">
      <nav className="nav0">
        <Link href="/" aria-label="Loopcom Community home">
          <img src="/brand/loopcom-nav.png" alt="Loopcom" />
        </Link>
        <span style={{ flex: 1 }} />
        <Link className="btn" href="/login" data-testid="marketplace-public-signin">
          Sign in
        </Link>
        <Link className="btn p" href="/join" data-testid="marketplace-public-join">
          Join free
        </Link>
      </nav>
      <div className="content">{body}</div>
    </div>
  );
}
