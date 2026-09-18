"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api } from "@/lib/api";
import { Button, Chip, Empty, Field, Skeleton, Switch, useToast } from "@/components/ui";

type Flag = {
  key: string;
  description: string | null;
  enabled: boolean;
  rollout: number;
  audience: "INTERNAL" | "SELECTED" | "PERCENT" | "ALL";
  allowPersons: string[];
  allowOrgs: string[];
  updatedAt: string;
};

const AUDIENCES: Flag["audience"][] = ["INTERNAL", "SELECTED", "PERCENT", "ALL"];
const NEW_FLAG: Flag = { key: "", description: "", enabled: false, rollout: 0, audience: "INTERNAL", allowPersons: [], allowOrgs: [], updatedAt: "" };

export default function AdminFlagsPage() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}

function Inner() {
  const { me } = useAuth();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Flag>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [newFlag, setNewFlag] = useState<Flag>(NEW_FLAG);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ flags: Flag[] }>("/admin/flags");
      setFlags(r.flags);
      setDrafts(Object.fromEntries(r.flags.map((f) => [f.key, f])));
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load feature flags.", { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (me?.staffRole) void load();
  }, [me, load]);

  if (!me) return null;
  if (!me.staffRole) {
    return (
      <AppShell title="Feature flags">
        <Empty title="Platform staff only" text="This screen is for Loopcom staff." />
      </AppShell>
    );
  }

  function patchDraft(key: string, patch: Partial<Flag>) {
    setDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  }

  async function save(key: string) {
    const draft = drafts[key];
    if (!draft) return;
    setSavingKey(key);
    try {
      const saved = await api<Flag>(`/admin/flags/${key}`, {
        method: "PUT",
        body: { enabled: draft.enabled, rollout: draft.rollout, audience: draft.audience, allowPersons: draft.allowPersons, allowOrgs: draft.allowOrgs, description: draft.description ?? undefined },
      });
      setFlags((fs) => fs.map((f) => (f.key === key ? saved : f)));
      setDrafts((d) => ({ ...d, [key]: saved }));
      toast(`${key} saved.`);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't save that flag.", { kind: "err" });
    } finally {
      setSavingKey(null);
    }
  }

  async function emergencyDisable(key: string) {
    patchDraft(key, { enabled: false });
    setSavingKey(key);
    try {
      const saved = await api<Flag>(`/admin/flags/${key}`, { method: "PUT", body: { ...drafts[key], enabled: false } });
      setFlags((fs) => fs.map((f) => (f.key === key ? saved : f)));
      setDrafts((d) => ({ ...d, [key]: saved }));
      toast(`${key} disabled.`, { kind: "err" });
    } catch (e: any) {
      toast(e?.message ?? "Couldn't disable that flag.", { kind: "err" });
    } finally {
      setSavingKey(null);
    }
  }

  async function createFlag(e: React.FormEvent) {
    e.preventDefault();
    if (!newFlag.key.trim()) return;
    setCreating(true);
    try {
      const saved = await api<Flag>(`/admin/flags/${newFlag.key.trim()}`, {
        method: "PUT",
        body: { enabled: newFlag.enabled, rollout: newFlag.rollout, audience: newFlag.audience, allowPersons: [], allowOrgs: [], description: newFlag.description || undefined },
      });
      setFlags((fs) => [...fs, saved]);
      setDrafts((d) => ({ ...d, [saved.key]: saved }));
      setNewFlag(NEW_FLAG);
      toast("Flag created.");
    } catch (e: any) {
      toast(e?.message ?? "Couldn't create that flag.", { kind: "err" });
    } finally {
      setCreating(false);
    }
  }

  return (
    <AppShell title="Feature flags">
      <div className="card" data-testid="admin-flags-new">
        <div className="ct">New flag</div>
        <form onSubmit={createFlag} className="grid2">
          <Field label="Key" htmlFor="flag-key" help="e.g. community.semantic_search">
            <input id="flag-key" className="in mono" value={newFlag.key} onChange={(e) => setNewFlag((f) => ({ ...f, key: e.target.value }))} required data-testid="admin-flags-new-key" />
          </Field>
          <Field label="Description" htmlFor="flag-desc">
            <input id="flag-desc" className="in" value={newFlag.description ?? ""} onChange={(e) => setNewFlag((f) => ({ ...f, description: e.target.value }))} data-testid="admin-flags-new-description" />
          </Field>
          <Button kind="p" type="submit" loading={creating} data-testid="admin-flags-new-create">
            Create flag
          </Button>
        </form>
      </div>

      <div className="card" data-testid="admin-flags-list">
        <div className="ct">All flags</div>
        {loading ? (
          <Skeleton h={140} />
        ) : flags.length === 0 ? (
          <Empty title="No feature flags yet" />
        ) : (
          <div className="list" data-testid="admin-flags-table">
            {flags.map((f) => {
              const d = drafts[f.key] ?? f;
              return (
                <div className="li" key={f.key} style={{ alignItems: "flex-start" }} data-testid={`admin-flags-row-${f.key}`}>
                  <div className="t" style={{ flex: 1 }}>
                    <b className="mono" style={{ fontSize: 12 }}>
                      {f.key}
                    </b>
                    <small>{f.description}</small>
                    <div className="row" style={{ marginTop: 8, flexWrap: "wrap", gap: 10 }}>
                      <Switch id={`flag-enabled-${f.key}`} label="Enabled" on={d.enabled} onChange={(v) => patchDraft(f.key, { enabled: v })} />
                      <label className="sm" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        Audience
                        <select className="in" value={d.audience} onChange={(e) => patchDraft(f.key, { audience: e.target.value as Flag["audience"] })} data-testid={`admin-flags-audience-${f.key}`}>
                          {AUDIENCES.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                      </label>
                      {d.audience === "PERCENT" ? (
                        <label className="sm" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          Rollout %
                          <input
                            className="in"
                            type="number"
                            min={0}
                            max={100}
                            style={{ width: 70 }}
                            value={d.rollout}
                            onChange={(e) => patchDraft(f.key, { rollout: Number(e.target.value) })}
                            data-testid={`admin-flags-rollout-${f.key}`}
                          />
                        </label>
                      ) : null}
                      {d.audience === "SELECTED" ? (
                        <label className="sm" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          Allowed people (ids, comma-separated)
                          <input
                            className="in"
                            style={{ width: 220 }}
                            value={d.allowPersons.join(",")}
                            onChange={(e) => patchDraft(f.key, { allowPersons: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
                            data-testid={`admin-flags-allowpersons-${f.key}`}
                          />
                        </label>
                      ) : null}
                    </div>
                  </div>
                  <div className="row">
                    <Button small kind="p" loading={savingKey === f.key} onClick={() => save(f.key)} data-testid={`admin-flags-save-${f.key}`}>
                      Save
                    </Button>
                    {f.enabled ? (
                      <Button small kind="d" loading={savingKey === f.key} onClick={() => emergencyDisable(f.key)} data-testid={`admin-flags-disable-${f.key}`}>
                        Emergency disable
                      </Button>
                    ) : (
                      <Chip>off</Chip>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
