"use client";

import { api, ApiError, newIdempotencyKey } from "@/lib/api";
import { Avatar, Button, Dialog, useToast } from "@/components/ui";
import type { PersonCardData } from "@/components/profile/ProfileCard";

/** Picker for "ask for a referral" — the people-you-know-here list is already loaded on the job detail. */
export function ReferralDialog({ open, onClose, jobId, people }: { open: boolean; onClose: () => void; jobId: string; people: PersonCardData[] }) {
  const toast = useToast();
  return (
    <Dialog open={open} onClose={onClose} title="Ask for a referral">
      <div className="jobs-referral-list">
        {people.length ? (
          people.map((p) => (
            <div className="li" key={p.id}>
              <Avatar name={p.name} assetId={p.avatarAssetId} size={36} />
              <div className="t">
                <b>{p.name}</b>
              </div>
              <Button
                small
                kind="p"
                data-testid={`jobs-referral-send-${p.id}`}
                onClick={async () => {
                  try {
                    await api(`/jobs/${jobId}/ask-referral`, { method: "POST", body: { personId: p.id }, idempotencyKey: newIdempotencyKey() });
                    toast(`Sent to ${p.name}.`);
                    onClose();
                  } catch (e) {
                    toast(e instanceof ApiError ? e.message : "Couldn't send that.", { kind: "err" });
                  }
                }}
              >
                Ask
              </Button>
            </div>
          ))
        ) : (
          <p className="sm dim">None of your connections at this company are shown here yet.</p>
        )}
      </div>
    </Dialog>
  );
}
