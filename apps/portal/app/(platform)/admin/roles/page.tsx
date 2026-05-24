"use client";

import { useState } from "react";
import { Plus, Shield, Users, Eye, EyeOff, Copy, Trash2, Edit3 } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "../../../../components/PageHeader";
import { PermissionGate } from "../../../../components/PermissionGate";
import { useAsyncResource } from "../../../../hooks/useAsyncResource";
import { apiDelete, apiGet, apiPost } from "../../../../services/apiClient";
import { useAppContext } from "../../../../hooks/useAppContext";

type CustomRole = {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  active: boolean;
  permissions: string[];
  userCount: number;
  createdAt: string;
  updatedAt: string;
};

type RolesResponse = { roles: CustomRole[] };

export default function CustomRolesPage() {
  const { role } = useAppContext();
  const isSuperAdmin = role === "SUPER_ADMIN";

  const [deleting, setDeleting] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [tick, setTick] = useState(0);

  function refresh() { setTick((t) => t + 1); }

  const roles = useAsyncResource<RolesResponse>(
    () => apiGet("/admin/custom-roles"),
    [tick],
  );

  async function handleDuplicate(role: CustomRole) {
    setDuplicating(role.id);
    setActionMsg(null);
    try {
      await apiPost(`/admin/custom-roles/${role.id}/duplicate`, {});
      setActionMsg({ type: "success", text: `Duplicated "${role.name}" — new role created as inactive.` });
      refresh();
    } catch (err: any) {
      setActionMsg({ type: "error", text: err?.message || "Duplicate failed." });
    } finally {
      setDuplicating(null);
    }
  }

  async function handleDelete(role: CustomRole) {
    if (!confirm(`Delete role "${role.name}"? This will remove it from all ${role.userCount} assigned user(s).`)) return;
    setDeleting(role.id);
    setActionMsg(null);
    try {
      await apiDelete(`/admin/custom-roles/${role.id}`);
      setActionMsg({ type: "success", text: `Deleted "${role.name}".` });
      refresh();
    } catch (err: any) {
      setActionMsg({ type: "error", text: err?.message || "Delete failed." });
    } finally {
      setDeleting(null);
    }
  }

  return (
    <PermissionGate
      permission="can_view_admin_roles"
      fallback={
        <div className="state-box" style={{ padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Access denied</div>
          <p className="muted">You do not have permission to manage custom roles.</p>
        </div>
      }
    >
      <div className="stack compact-stack">
        <PageHeader
          title="Custom Roles"
          subtitle="Create and manage custom permission roles for your tenant."
          actions={
            <Link href="/admin/roles/new" className="btn">
              <Plus size={15} style={{ marginRight: 6 }} />
              New Role
            </Link>
          }
        />

        {actionMsg && (
          <div className={`chip ${actionMsg.type === "success" ? "success" : "danger"}`} style={{ alignSelf: "flex-start" }}>
            {actionMsg.text}
          </div>
        )}

        {roles.status === "loading" && (
          <div className="state-box muted" style={{ padding: 24, textAlign: "center" }}>Loading roles…</div>
        )}

        {roles.status === "error" && (
          <div className="chip danger" style={{ alignSelf: "flex-start" }}>Failed to load roles.</div>
        )}

        {roles.status === "success" && roles.data.roles.length === 0 && (
          <div className="panel" style={{ padding: 40, textAlign: "center" }}>
            <Shield size={32} style={{ color: "var(--text-dim)", marginBottom: 12 }} />
            <div style={{ fontWeight: 700, marginBottom: 6 }}>No custom roles yet</div>
            <p className="muted" style={{ marginBottom: 16 }}>
              Custom roles let you configure precise permission sets for users beyond the built-in role buckets.
            </p>
            <Link href="/admin/roles/new" className="btn">
              <Plus size={14} style={{ marginRight: 6 }} />
              Create your first role
            </Link>
          </div>
        )}

        {roles.status === "success" && roles.data.roles.length > 0 && (
          <div className="panel" style={{ overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)" }}>
                  <th style={{ textAlign: "left", padding: "10px 16px", fontWeight: 600 }}>Role</th>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600 }}>Permissions</th>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600 }}>Users</th>
                  <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600 }}>Status</th>
                  <th style={{ textAlign: "right", padding: "10px 16px", fontWeight: 600 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {roles.data.roles.map((role: CustomRole, idx: number) => (
                  <tr
                    key={role.id}
                    style={{
                      borderBottom: idx < roles.data.roles.length - 1 ? "1px solid var(--border)" : undefined,
                      background: idx % 2 === 0 ? undefined : "rgba(255,255,255,0.01)",
                      opacity: role.active ? 1 : 0.6,
                    }}
                  >
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <Shield size={15} style={{ color: role.active ? "var(--info)" : "var(--text-dim)", flexShrink: 0 }} />
                        <div>
                          <div style={{ fontWeight: 650, fontSize: 13 }}>{role.name}</div>
                          {role.description && (
                            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{role.description}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: "12px 14px" }}>
                      <span className="chip" style={{ fontSize: 11 }}>{role.permissions.length} permissions</span>
                    </td>
                    <td style={{ padding: "12px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
                        <Users size={12} style={{ color: "var(--text-dim)" }} />
                        {role.userCount}
                      </div>
                    </td>
                    <td style={{ padding: "12px 14px" }}>
                      {role.active
                        ? <span className="chip success" style={{ fontSize: 11 }}>Active</span>
                        : <span className="chip" style={{ fontSize: 11, opacity: 0.7 }}>Inactive</span>
                      }
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <Link
                          href={`/admin/roles/${role.id}`}
                          className="btn ghost"
                          style={{ fontSize: 12, padding: "4px 10px" }}
                          title="Edit role"
                        >
                          <Edit3 size={13} />
                        </Link>
                        <button
                          className="btn ghost"
                          style={{ fontSize: 12, padding: "4px 10px" }}
                          title="Duplicate role"
                          onClick={() => handleDuplicate(role)}
                          disabled={duplicating === role.id}
                        >
                          <Copy size={13} />
                        </button>
                        <button
                          className="btn ghost danger"
                          style={{ fontSize: 12, padding: "4px 10px" }}
                          title="Delete role"
                          onClick={() => handleDelete(role)}
                          disabled={deleting === role.id}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="panel" style={{ padding: "12px 16px" }}>
          <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
            <strong>How custom roles work:</strong> Custom roles grant permissions <em>additively</em> on top of a user's built-in role.
            Assigning a custom role never removes existing permissions. Inactive roles are ignored during permission resolution.
            {!isSuperAdmin && (
              <span> As a tenant admin, you can only grant permissions that you yourself hold.</span>
            )}
          </div>
        </div>
      </div>
    </PermissionGate>
  );
}
