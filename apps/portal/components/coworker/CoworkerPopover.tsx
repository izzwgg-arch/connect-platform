"use client";
/**
 * The bubble's chat — the compact Coworker in the desktop app's popover window
 * (/desktop/coworker). Same session hook as the full page, so everything the full
 * page does with a task, this does too; "Open full page" carries the task across.
 */
import { useMemo } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { useUiLanguage } from "../../hooks/useUiLanguage";
import { useAppContext } from "../../hooks/useAppContext";
import { useCoworkerSession } from "./useCoworkerSession";
import { CoworkerChatView, CoworkerMark, CHAT_PHRASES } from "./CoworkerChatView";
import { CoworkerComposer, COMPOSER_PHRASES } from "./CoworkerComposer";
import { closeBubble, coworkerUi } from "./coworkerBridge";
import { COWORKER_STYLES } from "./coworkerStyles";

export const COWORKER_PAGE_PERMISSION = "can_view_workspace_coworker" as const;

const POPOVER_PHRASES = ["Coworker", "New task", "Open full page", "Minimize", "Ready", "Working…", "Waiting for your answer", "Waiting for your OK", "Not connected", "That didn't work. Try again."];

export function CoworkerPopover() {
  const phrases = useMemo(() => [...POPOVER_PHRASES, ...CHAT_PHRASES, ...COMPOSER_PHRASES], []);
  const { t } = useUiLanguage(phrases);
  const { can } = useAppContext();
  const s = useCoworkerSession({ path: "/desktop/coworker" });
  const desktop = !!coworkerUi();
  const canFullPage = can(COWORKER_PAGE_PERMISSION);

  const openFull = () => {
    const route = s.taskId ? `/coworker?task=${encodeURIComponent(s.taskId)}` : "/coworker";
    const b = coworkerUi();
    if (b) { void b.openFull(route); return; }
    window.location.assign(route);
  };

  return (
    <div className="cw-root cw-popover">
      <style>{COWORKER_STYLES}</style>
      <div className="cw-whead">
        <CoworkerMark />
        <div className="cw-wtitle">
          <b>{t("Coworker")}</b>
          <span className={`cw-status${s.status.tone === "busy" ? " busy" : s.status.tone === "off" ? " off" : ""}`}><i /><span>{t(s.status.text)}</span></span>
        </div>
        <button type="button" className="cw-icon-btn" title={t("New task")} aria-label={t("New task")} onClick={s.newTask} disabled={!!s.activeTurnId}>
          <Plus size={16} />
        </button>
        {canFullPage && (
          <button type="button" className="cw-icon-btn" title={t("Open full page")} aria-label={t("Open full page")} onClick={openFull}>
            <Maximize2 size={15} />
          </button>
        )}
        <button type="button" className="cw-icon-btn" title={t("Minimize")} aria-label={t("Minimize")} onClick={closeBubble}>
          <Minus size={16} />
        </button>
      </div>
      <CoworkerChatView s={s} t={t} desktop={desktop} />
      <CoworkerComposer s={s} t={t} compact />
    </div>
  );
}
