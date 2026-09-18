"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api, ApiError } from "@/lib/api";
import { Button, Chip, Field, useToast } from "@/components/ui";
import { Uploader, type UploadedAsset } from "@/components/media/Uploader";
import "@/components/marketplace/marketplace.css";

type CategoryNode = { id: string; slug: string; name: string; count: number; children: CategoryNode[] };

function flatten(nodes: CategoryNode[], depth = 0): Array<{ slug: string; name: string; depth: number }> {
  return nodes.flatMap((n) => [{ slug: n.slug, name: n.name, depth }, ...flatten(n.children, depth + 1)]);
}

const TYPES = [
  { value: "SERVICE", label: "Service" },
  { value: "PRODUCT", label: "Product" },
  { value: "WHOLESALE", label: "Wholesale" },
  { value: "BUSINESS_ASSET", label: "Business asset" },
  { value: "PROFESSIONAL_SERVICE", label: "Professional service" },
];

function NewListingForm() {
  const router = useRouter();
  const toast = useToast();
  const { me } = useAuth();
  const [categories, setCategories] = useState<Array<{ slug: string; name: string; depth: number }>>([]);
  const [organizationId, setOrganizationId] = useState("");
  const [type, setType] = useState("SERVICE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [categorySlug, setCategorySlug] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [priceUnit, setPriceUnit] = useState("");
  const [minimumOrder, setMinimumOrder] = useState("");
  const [turnaround, setTurnaround] = useState("");
  const [delivery, setDelivery] = useState("");
  const [availability, setAvailability] = useState("AVAILABLE");
  const [areaInput, setAreaInput] = useState("");
  const [serviceArea, setServiceArea] = useState<string[]>([]);
  const [media, setMedia] = useState<UploadedAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ categories: CategoryNode[] }>("/marketplace/categories")
      .then((r) => setCategories(flatten(r.categories)))
      .catch(() => setCategories([]));
  }, []);

  function addArea() {
    const v = areaInput.trim();
    if (!v || serviceArea.includes(v)) return;
    setServiceArea((s) => [...s, v]);
    setAreaInput("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (title.trim().length < 3) {
      setError("Give the listing a title.");
      return;
    }
    if (!description.trim()) {
      setError("Describe what you're offering.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const listing = await api<{ listing: { id: string } }>("/listings", {
        method: "POST",
        body: {
          type,
          title: title.trim(),
          description: description.trim(),
          categorySlug: categorySlug || undefined,
          organizationId: organizationId || undefined,
          priceMin: priceMin ? Number(priceMin) : undefined,
          priceMax: priceMax ? Number(priceMax) : undefined,
          priceUnit: priceUnit.trim() || undefined,
          minimumOrder: minimumOrder.trim() || undefined,
          turnaround: turnaround.trim() || undefined,
          delivery: delivery.trim() || undefined,
          availability,
          serviceArea,
          mediaAssetIds: media.map((m) => m.id),
        },
      });
      toast("Listing posted.");
      router.push(`/marketplace/${listing.listing.id}`);
    } catch (err) {
      setError((err as ApiError).message ?? "Couldn't post that listing.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gridColumn: "1/-1", maxWidth: 640 }}>
      <form className="card" onSubmit={submit}>
        <div className="ct">Post a listing</div>

        <Field label="Posting as" htmlFor="lst-org">
          <select id="lst-org" className="in" value={organizationId} onChange={(e) => setOrganizationId(e.target.value)} data-testid="marketplace-new-org">
            <option value="">Just me</option>
            {(me?.memberships ?? []).map((m) => (
              <option key={m.organization.id} value={m.organization.id}>
                {m.organization.displayName}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Type" htmlFor="lst-type">
          <select id="lst-type" className="in" value={type} onChange={(e) => setType(e.target.value)} data-testid="marketplace-new-type">
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Category" htmlFor="lst-cat">
          <select id="lst-cat" className="in" value={categorySlug} onChange={(e) => setCategorySlug(e.target.value)} data-testid="marketplace-new-category">
            <option value="">Uncategorized</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {"—".repeat(c.depth)} {c.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Title" htmlFor="lst-title">
          <input id="lst-title" className="in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} required data-testid="marketplace-new-title" />
        </Field>
        <Field label="Description" htmlFor="lst-desc">
          <textarea id="lst-desc" className="in" style={{ minHeight: 100 }} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} data-testid="marketplace-new-description" />
        </Field>

        <div className="grid2">
          <Field label="Price min" htmlFor="lst-pmin">
            <input id="lst-pmin" className="in" type="number" min={0} step="0.01" value={priceMin} onChange={(e) => setPriceMin(e.target.value)} data-testid="marketplace-new-pricemin" />
          </Field>
          <Field label="Price max" htmlFor="lst-pmax">
            <input id="lst-pmax" className="in" type="number" min={0} step="0.01" value={priceMax} onChange={(e) => setPriceMax(e.target.value)} data-testid="marketplace-new-pricemax" />
          </Field>
        </div>
        <Field label="Price unit" htmlFor="lst-punit" help="e.g. /pc, /mo, /hr">
          <input id="lst-punit" className="in" value={priceUnit} onChange={(e) => setPriceUnit(e.target.value)} maxLength={40} data-testid="marketplace-new-priceunit" />
        </Field>
        <Field label="Minimum order" htmlFor="lst-moq">
          <input id="lst-moq" className="in" value={minimumOrder} onChange={(e) => setMinimumOrder(e.target.value)} maxLength={120} data-testid="marketplace-new-moq" />
        </Field>
        <Field label="Turnaround" htmlFor="lst-turn">
          <input id="lst-turn" className="in" value={turnaround} onChange={(e) => setTurnaround(e.target.value)} maxLength={120} data-testid="marketplace-new-turnaround" />
        </Field>
        <Field label="Delivery" htmlFor="lst-del">
          <input id="lst-del" className="in" value={delivery} onChange={(e) => setDelivery(e.target.value)} maxLength={120} data-testid="marketplace-new-delivery" />
        </Field>
        <Field label="Availability" htmlFor="lst-avail">
          <select id="lst-avail" className="in" value={availability} onChange={(e) => setAvailability(e.target.value)} data-testid="marketplace-new-availability">
            <option value="AVAILABLE">Available</option>
            <option value="LIMITED">Limited availability</option>
            <option value="SOLD_OUT">Sold out</option>
          </select>
        </Field>

        <Field label="Service area" htmlFor="lst-area" help="Towns or regions you serve">
          <div className="row">
            <input
              id="lst-area"
              className="in"
              style={{ flex: 1 }}
              value={areaInput}
              onChange={(e) => setAreaInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addArea();
                }
              }}
              data-testid="marketplace-new-area-input"
            />
            <Button type="button" small onClick={addArea} data-testid="marketplace-new-area-add">
              Add
            </Button>
          </div>
          <div className="mkt-service-area">
            {serviceArea.map((a) => (
              <Chip key={a} onClick={() => setServiceArea((s) => s.filter((x) => x !== a))} testId={`marketplace-new-area-${a}`}>
                {a} ×
              </Chip>
            ))}
          </div>
        </Field>

        <Field label="Photos" htmlFor="lst-media">
          <Uploader accept="image" multiple maxFiles={8} onChange={setMedia} testId="marketplace-new-uploader" />
        </Field>

        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row" style={{ marginTop: 10 }}>
          <Button kind="p" type="submit" loading={busy} data-testid="marketplace-new-submit">
            Post listing
          </Button>
          <Button kind="g" type="button" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function NewListingPage() {
  return (
    <RequireAuth>
      <AppShell title="Post a listing">
        <NewListingForm />
      </AppShell>
    </RequireAuth>
  );
}
