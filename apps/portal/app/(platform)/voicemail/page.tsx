"use client";

import { AudioPlayerRow } from "../../../components/AudioPlayerRow";
import { DetailCard } from "../../../components/DetailCard";
import { EmptyState } from "../../../components/EmptyState";
import { ErrorState } from "../../../components/ErrorState";
import { LoadingSkeleton } from "../../../components/LoadingSkeleton";
import { PageHeader } from "../../../components/PageHeader";
import { PermissionGate } from "../../../components/PermissionGate";
import { useAsyncResource } from "../../../hooks/useAsyncResource";
import { loadVoicemailData } from "../../../services/platformData";

export default function VoicemailPage() {
  const state = useAsyncResource(loadVoicemailData, []);
  if (state.status === "loading") return <LoadingSkeleton rows={5} />;
  if (state.status === "error") return <ErrorState message={state.error} />;
  const items = state.data;

  return (
    <PermissionGate permission="can_view_voicemail" fallback={<div className="state-box">You do not have voicemail access.</div>}>
      <div className="stack">
      <PageHeader title="Voicemail Workspace" subtitle="Play, download, call back, and manage voicemail messages quickly." />
      <DetailCard title="Inbox">
        {items.length === 0 ? (
          <EmptyState title="No voicemail messages" message="Unread voicemail items will be listed here for quick action." />
        ) : (
          <div className="stack">
            {items.map((item) => (
              <AudioPlayerRow key={item.id} title={item.title} from={item.from} duration={item.duration} />
            ))}
          </div>
        )}
      </DetailCard>
      </div>
    </PermissionGate>
  );
}
