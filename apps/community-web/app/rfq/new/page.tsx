"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RequireAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { Avatar, Button, Chip, Field, Switch, useToast } from "@/components/ui";
import { Uploader, type UploadedAsset } from "@/components/media/Uploader";
import "@/components/rfq/rfq.css";

type Extracted = {
  quantity: string | null;
  budgetMin: number | null;
  budgetMax: number | null;
  deadline: string | null;
  location: string | null;
  requirements: string[];
  categorySlug: string | null;
};
type Category = { id: string; slug: string; name: string; parentId: string | null };
type OrgOption = { id: string; slug: string; displayName: string; logoAssetId: string | null };

export default function NewRfqPage() {
  return (
    <RequireAuth>
      <AppShell title="Post a request for quotes">
        <Suspense fallback={null}>
          <Inner />
        </Suspense>
      </AppShell>
    </RequireAuth>
  );
}

function Inner() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [understanding, setUnderstanding] = useState(false);
  const [fromText, setFromText] = useState<Set<string>>(new Set());

  const [categories, setCategories] = useState<Category[]>([]);
  const [categorySlug, setCategorySlug] = useState("");
  const [quantity, setQuantity] = useState("");
  const [budgetMin, setBudgetMin] = useState("");
  const [budgetMax, setBudgetMax] = useState("");
  const [location, setLocation] = useState("");
  const [deadline, setDeadline] = useState("");
  const [closesAt, setClosesAt] = useState("");
  const [requirements, setRequirements] = useState("");
  const [visibility, setVisibility] = useState<"MATCHED" | "PUBLIC">("MATCHED");
  const [attachments, setAttachments] = useState<UploadedAsset[]>([]);

  const [vendorQuery, setVendorQuery] = useState("");
  const [vendorResults, setVendorResults] = useState<OrgOption[]>([]);
  const [invitedOrgs, setInvitedOrgs] = useState<OrgOption[]>([]);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    void api<{ categories: Category[] }>("/rfq/categories").then((r) => setCategories(r.categories));
  }, []);

  useEffect(() => {
    const vendorId = params.get("vendor");
    if (!vendorId) return;
    void api<{ organizations: OrgOption[] }>(`/organizations?q=${encodeURIComponent(vendorId)}&limit=1`).catch(() => null);
  }, [params]);

  useEffect(() => {
    if (vendorQuery.trim().length < 2) {
      setVendorResults([]);
      return;
    }
    const t = setTimeout(() => {
      void api<{ organizations: OrgOption[] }>(`/organizations?q=${encodeURIComponent(vendorQuery)}&limit=8`)
        .then((r) => setVendorResults(r.organizations))
        .catch(() => setVendorResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [vendorQuery]);

  const categoryTree = useMemo(() => {
    const roots = categories.filter((c) => !c.parentId);
    return roots.map((r) => ({ root: r, children: categories.filter((c) => c.parentId === r.id) }));
  }, [categories]);

  async function understand() {
    if (!description.trim()) {
      toast("Describe what you need first.", { kind: "err" });
      return;
    }
    setUnderstanding(true);
    try {
      const r = await api<{ extracted: Extracted }>("/rfq/preview", { method: "POST", body: { title, description } });
      const e = r.extracted;
      const filled = new Set<string>();
      if (e.quantity && !quantity) { setQuantity(e.quantity); filled.add("quantity"); }
      if (e.budgetMin != null && !budgetMin) { setBudgetMin(String(e.budgetMin)); filled.add("budgetMin"); }
      if (e.budgetMax != null && !budgetMax) { setBudgetMax(String(e.budgetMax)); filled.add("budgetMax"); }
      if (e.location && !location) { setLocation(e.location); filled.add("location"); }
      if (e.deadline && !deadline) { setDeadline(e.deadline); filled.add("deadline"); }
      if (e.categorySlug && !categorySlug) { setCategorySlug(e.categorySlug); filled.add("categorySlug"); }
      if (e.requirements.length && !requirements) { setRequirements(e.requirements.join("\n")); filled.add("requirements"); }
      setFromText(filled);
      setUnderstood(true);
      toast(filled.size ? "We filled in what we could find — check it over." : "Nothing to fill automatically — add the details below.");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't read that.", { kind: "err" });
    } finally {
      setUnderstanding(false);
    }
  }

  function addVendor(org: OrgOption) {
    if (invitedOrgs.some((o) => o.id === org.id)) return;
    setInvitedOrgs((s) => [...s, org]);
    setVendorQuery("");
    setVendorResults([]);
  }

  async function publish() {
    if (!title.trim() || !description.trim()) {
      toast("Add a title and description.", { kind: "err" });
      return;
    }
    setPublishing(true);
    try {
      const res = await api<{ rfq: { id: string } }>("/rfq", {
        method: "POST",
        idempotencyKey: newIdempotencyKey(),
        body: {
          title: title.trim(),
          description: description.trim(),
          categorySlug: categorySlug || undefined,
          quantity: quantity || undefined,
          budgetMin: budgetMin ? Number(budgetMin) : undefined,
          budgetMax: budgetMax ? Number(budgetMax) : undefined,
          location: location || undefined,
          deadline: deadline || undefined,
          closesAt: closesAt || undefined,
          requirements: requirements.trim() ? requirements.split("\n").map((s) => s.trim()).filter(Boolean) : undefined,
          attachmentAssetIds: attachments.map((a) => a.id),
          inviteOrganizationIds: invitedOrgs.map((o) => o.id),
          visibility,
        },
      });
      toast("Request published.");
      router.push(`/rfq/${res.rfq.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Couldn't publish that request.", { kind: "err" });
    } finally {
      setPublishing(false);
    }
  }

  const Label = ({ field, children }: { field: string; children: React.ReactNode }) => (
    <span className="row" style={{ gap: 0 }}>
      {children}
      {fromText.has(field) ? <span className="rfq-from-text">from your text</span> : null}
    </span>
  );

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 760 }}>
      <div className="card">
        <div className="ct">What do you need?</div>
        <Field label="Title" htmlFor="rfq-title">
          <input id="rfq-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Custom embroidered jackets for camp staff" data-testid="rfq-new-title" maxLength={200} />
        </Field>
        <Field label="Describe it in plain English" htmlFor="rfq-desc" help="Quantity, budget, deadline and location — we'll try to pull them out for you.">
          <textarea id="rfq-desc" className="rfq-textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Need 25 custom embroidered jackets delivered to Monroe before October 20…" data-testid="rfq-new-description" maxLength={8000} />
        </Field>
        <div className="row" style={{ marginTop: 8 }}>
          <Button kind="p" loading={understanding} onClick={() => void understand()} data-testid="rfq-new-understand">
            Understand my request
          </Button>
        </div>
      </div>

      {understood ? (
        <div className="card" data-testid="rfq-new-extracted">
          <div className="ct">Confirm the details</div>
          <div className="grid2">
            <Field label="Category" htmlFor="rfq-cat">
              <Label field="categorySlug">
                <select id="rfq-cat" className="in" value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} data-testid="rfq-new-category">
                  <option value="">Choose a category…</option>
                  {categoryTree.map(({ root, children }) => (
                    <optgroup key={root.id} label={root.name}>
                      <option value={root.slug}>{root.name}</option>
                      {children.map((c) => (
                        <option key={c.id} value={c.slug}>
                          {c.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Label>
            </Field>
            <Field label="Quantity" htmlFor="rfq-qty">
              <Label field="quantity">
                <input id="rfq-qty" className="in" value={quantity} onChange={(e) => setQuantity(e.target.value)} data-testid="rfq-new-quantity" />
              </Label>
            </Field>
            <Field label="Budget min ($)" htmlFor="rfq-bmin">
              <Label field="budgetMin">
                <input id="rfq-bmin" className="in" inputMode="decimal" value={budgetMin} onChange={(e) => setBudgetMin(e.target.value)} data-testid="rfq-new-budgetmin" />
              </Label>
            </Field>
            <Field label="Budget max ($)" htmlFor="rfq-bmax">
              <Label field="budgetMax">
                <input id="rfq-bmax" className="in" inputMode="decimal" value={budgetMax} onChange={(e) => setBudgetMax(e.target.value)} data-testid="rfq-new-budgetmax" />
              </Label>
            </Field>
            <Field label="Location" htmlFor="rfq-loc">
              <Label field="location">
                <input id="rfq-loc" className="in" value={location} onChange={(e) => setLocation(e.target.value)} data-testid="rfq-new-location" />
              </Label>
            </Field>
            <Field label="Deadline" htmlFor="rfq-dl">
              <Label field="deadline">
                <input id="rfq-dl" type="date" className="in" value={deadline} onChange={(e) => setDeadline(e.target.value)} data-testid="rfq-new-deadline" />
              </Label>
            </Field>
          </div>
          <Field label="Requirements (one per line)" htmlFor="rfq-req">
            <Label field="requirements">
              <textarea id="rfq-req" className="rfq-textarea" style={{ minHeight: 70 }} value={requirements} onChange={(e) => setRequirements(e.target.value)} data-testid="rfq-new-requirements" />
            </Label>
          </Field>

          <div className="ct" style={{ marginTop: 14 }}>Attachments</div>
          <Uploader accept={["image", "document"]} multiple maxFiles={6} onChange={setAttachments} testId="rfq-new-uploader" />

          <div className="ct" style={{ marginTop: 14 }}>Invite specific vendors (optional)</div>
          <input className="in" placeholder="Search companies…" value={vendorQuery} onChange={(e) => setVendorQuery(e.target.value)} data-testid="rfq-new-vendor-search" />
          {vendorResults.length ? (
            <div className="list sm" style={{ marginTop: 6 }}>
              {vendorResults.map((o) => (
                <div className="li" key={o.id} style={{ cursor: "pointer" }} onClick={() => addVendor(o)} data-testid={`rfq-new-vendor-result-${o.id}`}>
                  <Avatar name={o.displayName} assetId={o.logoAssetId} size={28} square />
                  <div className="t">
                    <b>{o.displayName}</b>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {invitedOrgs.length ? (
            <div className="pill-row" style={{ marginTop: 8 }}>
              {invitedOrgs.map((o) => (
                <Chip key={o.id} onClick={() => setInvitedOrgs((s) => s.filter((x) => x.id !== o.id))} icon="x" testId={`rfq-new-invited-${o.id}`}>
                  {o.displayName}
                </Chip>
              ))}
            </div>
          ) : null}

          <div className="ct" style={{ marginTop: 14 }}>Visibility &amp; closing</div>
          <div className="li" style={{ alignItems: "center" }}>
            <div className="t">
              <b style={{ fontWeight: 500 }}>Visible to anyone (public), not just matched vendors</b>
            </div>
            <Switch on={visibility === "PUBLIC"} onChange={(v) => setVisibility(v ? "PUBLIC" : "MATCHED")} label="Public visibility" id="rfq-vis" />
          </div>
          <Field label="Closes on (optional — defaults to 14 days out, or your deadline)" htmlFor="rfq-closes">
            <input id="rfq-closes" type="date" className="in" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} data-testid="rfq-new-closes" />
          </Field>

          <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
            <Button kind="p" loading={publishing} onClick={() => void publish()} data-testid="rfq-new-publish">
              Publish request
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
