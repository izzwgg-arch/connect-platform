"use client";

import { useEffect, useState } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import type { CampaignListItem } from "./campaignTypes";

export function EditCampaignModal({
  campaign,
  onClose,
  onSave,
}: {
  campaign: Pick<CampaignListItem, "id" | "name" | "description" | "priority" | "status">;
  onClose: () => void;
  onSave: (data: {
    name: string;
    description?: string | null;
    priority: CampaignListItem["priority"];
    status?: CampaignListItem["status"];
  }) => Promise<void>;
}) {
  const [name, setName] = useState(campaign.name);
  const [description, setDescription] = useState(campaign.description ?? "");
  const [priority, setPriority] = useState(campaign.priority);
  const [status, setStatus] = useState(campaign.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setName(campaign.name);
    setDescription(campaign.description ?? "");
    setPriority(campaign.priority);
    setStatus(campaign.status);
  }, [campaign]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        priority,
        status: status !== campaign.status ? status : undefined,
      });
      onClose();
    } catch (err: unknown) {
      setError((err as Error)?.message ?? "Failed to save campaign");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={crm.campaignModalBackdrop}>
      <div className={cn(crm.card, "w-full max-w-md p-6 shadow-xl")}>
        <h2 className="mb-1 text-lg font-semibold text-crm-text">Edit campaign</h2>
        <p className="mb-4 text-sm text-crm-muted">Update name, description, priority, or lifecycle status.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-crm-text">Campaign name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={crm.input}
              maxLength={200}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-crm-text">
              Description <span className="font-normal text-crm-muted">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={cn(crm.input, "min-h-[5.5rem] resize-none")}
              rows={3}
              maxLength={2000}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-crm-text">Priority</label>
            <div className="flex flex-wrap gap-2">
              {(["LOW", "NORMAL", "HIGH", "URGENT"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPriority(p)}
                  className={cn(crm.campaignPriorityPill, priority === p && crm.campaignPriorityPillActive)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-crm-text">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as CampaignListItem["status"])} className={crm.input}>
              {(["DRAFT", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"] as const).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          {error ? <p className="text-sm text-crm-danger">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className={crm.btnSecondary} disabled={saving}>
              Cancel
            </button>
            <button type="submit" disabled={saving || !name.trim()} className={crm.btnPrimary}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
