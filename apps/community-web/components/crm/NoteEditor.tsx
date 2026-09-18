"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Chip, useToast } from "@/components/ui";
import "./crm.css";

export type Note = {
  id: string;
  body: string;
  tags: string[];
  dealValue: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Inline private-note editor for one person or business. Reusable from a
 * profile page, a company page, or a messages thread — every caller passes
 * exactly one of targetPersonId / targetOrgId. Notes here are never visible
 * to anyone but the person writing them.
 */
export function NoteEditor({ targetPersonId, targetOrgId }: { targetPersonId?: string; targetOrgId?: string }) {
  const toast = useToast();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [body, setBody] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const qs = targetPersonId ? `personId=${encodeURIComponent(targetPersonId)}` : `orgId=${encodeURIComponent(targetOrgId ?? "")}`;
      const r = await api<{ items: Note[] }>(`/crm/notes?${qs}`);
      setNotes(r.items);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load notes.", { kind: "err" });
    }
  }, [targetPersonId, targetOrgId, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await api("/crm/notes", {
        method: "POST",
        body: {
          ...(targetPersonId ? { targetPersonId } : { targetOrgId }),
          body: body.trim(),
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        },
      });
      setBody("");
      setTags("");
      await load();
      toast("Note saved.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that note.", { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    const prev = notes;
    setNotes((s) => s?.filter((n) => n.id !== id) ?? null);
    try {
      await api(`/crm/notes/${id}`, { method: "DELETE" });
    } catch (e: any) {
      setNotes(prev ?? null);
      toast(e?.message ?? "Couldn't delete that note.", { kind: "err" });
    }
  }

  return (
    <div data-testid="note-editor">
      <textarea className="note-input" placeholder="Add a private note — only you can see this…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} data-testid="note-editor-body" />
      <div className="row" style={{ marginTop: 6 }}>
        <input className="in" placeholder="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} style={{ flex: 1 }} data-testid="note-editor-tags" />
        <Button small kind="p" loading={saving} disabled={!body.trim()} onClick={add} data-testid="note-editor-save">
          Save note
        </Button>
      </div>
      {notes === null ? null : notes.length === 0 ? (
        <p className="sm dim" style={{ marginTop: 8 }}>
          No notes yet.
        </p>
      ) : (
        <div className="list sm" style={{ marginTop: 8 }} data-testid="note-editor-list">
          {notes.map((n) => (
            <div className="li" key={n.id} style={{ alignItems: "flex-start" }}>
              <div className="t">
                <div>{n.body}</div>
                {n.tags.length ? (
                  <div className="row" style={{ marginTop: 4 }}>
                    {n.tags.map((t) => (
                      <Chip key={t}>{t}</Chip>
                    ))}
                  </div>
                ) : null}
                <small className="dim">{new Date(n.createdAt).toLocaleDateString()}</small>
              </div>
              <button type="button" className="ib" aria-label="Delete note" onClick={() => remove(n.id)} data-testid={`note-editor-delete-${n.id}`}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
