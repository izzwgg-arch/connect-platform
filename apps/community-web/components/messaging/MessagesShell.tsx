"use client";

import { useCallback, useState } from "react";
import { Dialog, Empty, Icon } from "@/components/ui";
import { ThreadList } from "./ThreadList";
import { Conversation } from "./Conversation";
import { ThreadInfo } from "./ThreadInfo";
import "./messaging.css";

/**
 * The 3-pane messages screen. On desktop all three panes show at once; on
 * mobile (see messaging.css) only one pane shows at a time — the list when no
 * thread is open, the conversation when one is (info collapses into a dialog).
 */
export function MessagesShell({ threadId }: { threadId?: string }) {
  const [infoVersion, setInfoVersion] = useState(0);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const bumpInfo = useCallback(() => setInfoVersion((v) => v + 1), []);

  return (
    <div className={`msg-shell ${threadId ? "has-thread" : ""}`} data-testid="messages-shell">
      <ThreadList activeId={threadId} />
      {threadId ? (
        <Conversation threadId={threadId} onThreadChanged={bumpInfo} onOpenInfo={() => setMobileInfoOpen(true)} />
      ) : (
        <div className="msg-pane-conv">
          <Empty title="Select a conversation" text="Pick someone from the list, or start a new one from their profile." action={<Icon name="chat" />} />
        </div>
      )}
      {threadId ? <ThreadInfo threadId={threadId} version={infoVersion} /> : <div className="msg-pane-info" />}
      {threadId ? (
        <Dialog open={mobileInfoOpen} onClose={() => setMobileInfoOpen(false)} title="Conversation info">
          <ThreadInfo threadId={threadId} version={infoVersion} />
        </Dialog>
      ) : null}
    </div>
  );
}
