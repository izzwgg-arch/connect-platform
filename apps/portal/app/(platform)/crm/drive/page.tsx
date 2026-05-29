"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  HardDrive,
  Mail,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCcw,
  Trash2,
  FileText,
  ExternalLink,
  ChevronRight,
} from "lucide-react";
import { CRMPageShell, CRMPageHeader, CRMCard, crm, cn } from "../../../../components/crm";
import { apiGet, apiPost, apiDelete } from "../../../../services/apiClient";

// ── Types ──────────────────────────────────────────────────────────────────────

type DriveStatus = {
  gmailConnected: boolean;
  gmailEmail: string | null;
  driveConnected: boolean;
  driveEmail: string | null;
  driveConnectionId: string | null;
  folderConfig: FolderConfig | null;
};

type FolderConfig = {
  id: string;
  folderId: string;
  folderName: string;
  purpose: string;
  googleConnectionId: string;
  connectionEmail: string | null;
  connectionStatus: string | null;
  driveAccessValid: boolean;
  createdAt: string;
  updatedAt: string;
};

type DriveFolder = {
  id: string;
  name: string;
  modifiedTime: string | null;
};

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  modifiedTime: string | null;
  webViewLink: string | null;
};

// ── Utilities ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function mimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "PDF",
    "application/vnd.google-apps.document": "Google Doc",
    "application/vnd.google-apps.spreadsheet": "Google Sheet",
    "application/vnd.google-apps.presentation": "Google Slides",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "XLSX",
    "text/plain": "TXT",
    "text/csv": "CSV",
    "image/jpeg": "JPG",
    "image/png": "PNG",
  };
  return map[mimeType] ?? mimeType.split("/").pop()?.toUpperCase() ?? "File";
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ connected, label }: { connected: boolean; label: string }) {
  return (
    <span
      className={cn(
        crm.chip,
        "text-[10px] uppercase tracking-wide",
        connected
          ? "border-crm-success/35 bg-crm-success/10 text-crm-success"
          : "border-crm-danger/35 bg-crm-danger/10 text-crm-danger",
      )}
    >
      <span className={connected ? crm.statusDotLive : crm.statusDotDanger} />
      {label}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CrmDrivePage() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [folders, setFolders] = useState<DriveFolder[] | null>(null);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [foldersError, setFoldersError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string>("");
  const [selectedFolderName, setSelectedFolderName] = useState<string>("");

  const [savingFolder, setSavingFolder] = useState(false);
  const [saveFolderError, setSaveFolderError] = useState<string | null>(null);

  const [testResult, setTestResult] = useState<{ ok: boolean; folderName: string | null; fileCount: number } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const [recentFiles, setRecentFiles] = useState<DriveFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const [connecting, setConnecting] = useState(false);
  const [removingFolder, setRemovingFolder] = useState(false);

  const justConnected = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("connected") === "1";
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiGet<DriveStatus>("/crm/drive/status");
      setStatus(data);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load Drive status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleConnectDrive = async () => {
    setConnecting(true);
    try {
      const resp = await apiPost<{ url: string }>("/crm/drive/oauth/start", {
        connectionId: status?.driveConnectionId ?? null,
      });
      window.location.href = resp.url;
    } catch (e: any) {
      setConnecting(false);
      setError(e?.message ?? "Failed to start Drive authorization");
    }
  };

  const handleLoadFolders = async () => {
    setFoldersLoading(true);
    setFoldersError(null);
    setFolders(null);
    try {
      const resp = await apiGet<{ folders: DriveFolder[] }>("/crm/drive/folders");
      setFolders(resp.folders);
    } catch (e: any) {
      setFoldersError(e?.message ?? "Failed to load folders");
    } finally {
      setFoldersLoading(false);
    }
  };

  const handleSaveFolder = async () => {
    if (!selectedFolderId || !selectedFolderName || !status?.driveConnectionId) return;
    setSavingFolder(true);
    setSaveFolderError(null);
    try {
      await apiPost("/crm/drive/folder-config", {
        connectionId: status.driveConnectionId,
        folderId: selectedFolderId,
        folderName: selectedFolderName,
      });
      setSelectedFolderId("");
      setSelectedFolderName("");
      setFolders(null);
      setTestResult(null);
      setRecentFiles(null);
      await loadStatus();
    } catch (e: any) {
      setSaveFolderError(e?.message ?? "Failed to save folder");
    } finally {
      setSavingFolder(false);
    }
  };

  const handleRemoveFolder = async () => {
    setRemovingFolder(true);
    try {
      await apiDelete("/crm/drive/folder-config");
      setTestResult(null);
      setRecentFiles(null);
      await loadStatus();
    } catch (e: any) {
      setError(e?.message ?? "Failed to remove folder config");
    } finally {
      setRemovingFolder(false);
    }
  };

  const handleTestFolder = async () => {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const resp = await apiPost<{ ok: boolean; folderName: string | null; fileCount: number }>(
        "/crm/drive/folder-config/test",
        {},
      );
      setTestResult(resp);
    } catch (e: any) {
      setTestError(e?.message ?? "Folder test failed");
    } finally {
      setTesting(false);
    }
  };

  const handleLoadRecentFiles = async () => {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const resp = await apiGet<{ folderName: string; folderId: string; files: DriveFile[] }>(
        "/crm/drive/folder-config/files?limit=10",
      );
      setRecentFiles(resp.files);
    } catch (e: any) {
      setFilesError(e?.message ?? "Failed to load files");
    } finally {
      setFilesLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <CRMPageShell>
      <CRMPageHeader
        title="Google Drive Integration"
        subtitle="Connect Google Drive to enable lead document discovery and attachment."
        icon={<HardDrive className="h-5 w-5" />}
      />

      {justConnected && (
        <div className="mb-4 flex items-center gap-2 text-sm rounded-lg border border-crm-success/30 bg-crm-success/10 text-crm-success px-3 py-2.5">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Google Drive connected successfully. You can now select a folder below.
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-center gap-2 text-sm rounded-lg border border-crm-danger/30 bg-crm-danger/10 text-crm-danger px-3 py-2.5">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <CRMCard>
          <div className="flex items-center gap-2 text-crm-muted text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Drive status…
          </div>
        </CRMCard>
      ) : status && (
        <div className="flex flex-col gap-4">

          {/* ── Google Account Status ── */}
          <CRMCard>
            <h3 className="text-sm font-semibold text-crm-text mb-3">Google Account Status</h3>
            <div className="flex flex-col gap-3">

              {/* Gmail */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-crm-text">
                  <Mail className="h-4 w-4 text-crm-muted" />
                  <span className="font-medium">Gmail</span>
                  {status.gmailEmail && (
                    <span className="text-crm-muted text-xs">{status.gmailEmail}</span>
                  )}
                </div>
                <StatusBadge
                  connected={status.gmailConnected}
                  label={status.gmailConnected ? "Connected" : "Not connected"}
                />
              </div>

              {/* Drive */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm text-crm-text">
                  <HardDrive className="h-4 w-4 text-crm-muted" />
                  <span className="font-medium">Google Drive</span>
                  {status.driveEmail && (
                    <span className="text-crm-muted text-xs">{status.driveEmail}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge
                    connected={status.driveConnected}
                    label={status.driveConnected ? "Connected" : "Not connected"}
                  />
                  {!status.driveConnected && (
                    <button
                      className={crm.btnPrimary}
                      onClick={handleConnectDrive}
                      disabled={connecting}
                    >
                      {connecting ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Redirecting…</>
                      ) : (
                        <><HardDrive className="h-3.5 w-3.5" /> Connect Google Drive</>
                      )}
                    </button>
                  )}
                  {status.driveConnected && (
                    <button
                      className={crm.btnSecondary}
                      onClick={handleConnectDrive}
                      disabled={connecting}
                      title="Reconnect to refresh Drive permissions"
                    >
                      {connecting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <RefreshCcw className="h-3.5 w-3.5" />
                      )}
                      Reconnect
                    </button>
                  )}
                </div>
              </div>

            </div>
          </CRMCard>

          {/* ── Folder Configuration ── */}
          {status.driveConnected && (
            <CRMCard>
              <h3 className="text-sm font-semibold text-crm-text mb-1">Lead Documents Folder</h3>
              <p className="text-crm-muted text-xs mb-3">
                Select the Google Drive folder where lead documents are stored.
                This folder will be used for future lead document discovery.
              </p>

              {/* Saved config */}
              {status.folderConfig ? (
                <div className="flex flex-col gap-3">
                  <div className={cn(crm.card, "p-3 flex items-center justify-between gap-3")}>
                    <div className="flex items-center gap-2 min-w-0">
                      <FolderOpen className="h-4 w-4 text-crm-accent shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-crm-text truncate">
                          {status.folderConfig.folderName}
                        </p>
                        <p className="text-[10px] text-crm-muted font-mono">
                          {status.folderConfig.folderId}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {status.folderConfig.driveAccessValid ? (
                        <span className={cn(crm.chip, "text-[10px] border-crm-success/35 bg-crm-success/10 text-crm-success")}>
                          <CheckCircle2 className="h-3 w-3" /> Access OK
                        </span>
                      ) : (
                        <span className={cn(crm.chip, "text-[10px] border-crm-danger/35 bg-crm-danger/10 text-crm-danger")}>
                          <AlertCircle className="h-3 w-3" /> Reconnect required
                        </span>
                      )}
                      <button
                        className={crm.btnDanger}
                        onClick={handleRemoveFolder}
                        disabled={removingFolder}
                        title="Remove this folder configuration"
                      >
                        {removingFolder ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Test + recent files */}
                  <div className="flex gap-2">
                    <button
                      className={crm.btnSecondary}
                      onClick={handleTestFolder}
                      disabled={testing}
                    >
                      {testing ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Testing…</>
                      ) : (
                        <>Test Folder Access</>
                      )}
                    </button>
                    <button
                      className={crm.btnSecondary}
                      onClick={handleLoadRecentFiles}
                      disabled={filesLoading}
                    >
                      {filesLoading ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
                      ) : (
                        <><FileText className="h-3.5 w-3.5" /> Show Recent Files</>
                      )}
                    </button>
                  </div>

                  {testError && (
                    <div className="flex items-center gap-2 text-sm rounded-lg border border-crm-danger/30 bg-crm-danger/10 text-crm-danger px-3 py-2.5">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {testError}
                    </div>
                  )}

                  {testResult && (
                    <div className={cn(
                      testResult.ok
                        ? "border-crm-success/30 bg-crm-success/10 text-crm-success"
                        : "border-crm-danger/30 bg-crm-danger/10 text-crm-danger",
                      "flex items-center gap-2 text-sm rounded-lg border px-3 py-2.5",
                    )}>
                      {testResult.ok ? (
                        <><CheckCircle2 className="h-4 w-4 shrink-0" />
                          Folder &ldquo;{testResult.folderName}&rdquo; is accessible.
                          {testResult.fileCount > 0
                            ? ` Found ${testResult.fileCount} file(s).`
                            : " Folder appears empty."}
                        </>
                      ) : (
                        <><AlertCircle className="h-4 w-4 shrink-0" /> Folder access check failed.</>
                      )}
                    </div>
                  )}

                  {filesError && (
                    <div className="flex items-center gap-2 text-sm rounded-lg border border-crm-danger/30 bg-crm-danger/10 text-crm-danger px-3 py-2.5">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {filesError}
                    </div>
                  )}

                  {recentFiles && (
                    <div className="flex flex-col gap-1">
                      <p className="text-xs font-medium text-crm-muted mb-1">
                        Recent files in this folder:
                      </p>
                      {recentFiles.length === 0 ? (
                        <p className="text-xs text-crm-muted italic">No files found in this folder.</p>
                      ) : (
                        <div className="flex flex-col divide-y divide-crm-border/40">
                          {recentFiles.map((f) => (
                            <div key={f.id} className="flex items-center justify-between py-2 gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <FileText className="h-3.5 w-3.5 text-crm-muted shrink-0" />
                                <span className="text-xs text-crm-text truncate">{f.name}</span>
                                <span className="text-[10px] text-crm-muted shrink-0">
                                  {mimeLabel(f.mimeType)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-[10px] text-crm-muted">
                                  {formatBytes(f.size)}
                                </span>
                                <span className="text-[10px] text-crm-muted">
                                  {formatWhen(f.modifiedTime)}
                                </span>
                                {f.webViewLink && (
                                  <a
                                    href={f.webViewLink}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-crm-accent hover:text-crm-accent/80"
                                    title="Open in Drive"
                                  >
                                    <ExternalLink className="h-3 w-3" />
                                  </a>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* No folder saved yet — folder selector */
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <button
                      className={crm.btnSecondary}
                      onClick={handleLoadFolders}
                      disabled={foldersLoading}
                    >
                      {foldersLoading ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</>
                      ) : (
                        <><FolderOpen className="h-3.5 w-3.5" /> Browse Folders</>
                      )}
                    </button>
                    <span className="text-xs text-crm-muted">
                      or enter a folder ID directly below.
                    </span>
                  </div>

                  {foldersError && (
                    <div className="flex items-center gap-2 text-sm rounded-lg border border-crm-danger/30 bg-crm-danger/10 text-crm-danger px-3 py-2.5">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {foldersError}
                    </div>
                  )}

                  {folders && (
                    <div className="flex flex-col gap-1 max-h-48 overflow-y-auto border border-crm-border rounded-lg">
                      {folders.length === 0 ? (
                        <p className="p-3 text-xs text-crm-muted italic">
                          No folders found at the root of this Drive.
                        </p>
                      ) : (
                        folders.map((folder) => (
                          <button
                            key={folder.id}
                            className={cn(
                              "flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-crm-surface-2/50 transition-colors",
                              selectedFolderId === folder.id && "bg-crm-accent/10 text-crm-accent",
                            )}
                            onClick={() => {
                              setSelectedFolderId(folder.id);
                              setSelectedFolderName(folder.name);
                            }}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{folder.name}</span>
                            </div>
                            <ChevronRight className="h-3.5 w-3.5 text-crm-muted shrink-0" />
                          </button>
                        ))
                      )}
                    </div>
                  )}

                  {/* Manual folder ID input */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-crm-text">
                      Selected folder
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={selectedFolderName}
                        onChange={(e) => setSelectedFolderName(e.target.value)}
                        placeholder="Folder name"
                        className={cn(crm.input, "flex-1 text-sm")}
                      />
                      <input
                        type="text"
                        value={selectedFolderId}
                        onChange={(e) => setSelectedFolderId(e.target.value)}
                        placeholder="Folder ID (from Drive URL)"
                        className={cn(crm.input, "flex-1 text-sm font-mono")}
                      />
                    </div>
                    <p className="text-[10px] text-crm-muted">
                      Find the folder ID in the Drive URL after{" "}
                      <code className="font-mono">/folders/</code>
                    </p>
                  </div>

                  {saveFolderError && (
                    <div className="flex items-center gap-2 text-sm rounded-lg border border-crm-danger/30 bg-crm-danger/10 text-crm-danger px-3 py-2.5">
                      <AlertCircle className="h-4 w-4 shrink-0" />
                      {saveFolderError}
                    </div>
                  )}

                  <div>
                    <button
                      className={crm.btnPrimary}
                      onClick={handleSaveFolder}
                      disabled={savingFolder || !selectedFolderId || !selectedFolderName}
                    >
                      {savingFolder ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…</>
                      ) : (
                        <>Save Lead Documents Folder</>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </CRMCard>
          )}

          {/* ── What's next ── */}
          <CRMCard>
            <h3 className="text-sm font-semibold text-crm-text mb-2">What happens next</h3>
            <ul className="flex flex-col gap-1.5 text-xs text-crm-muted list-none p-0 m-0">
              <li className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-crm-success mt-0.5 shrink-0" />
                Drive connection and folder selection — <strong className="text-crm-text">available now</strong>
              </li>
              <li className="flex items-start gap-2">
                <span className="h-3.5 w-3.5 rounded-full border border-crm-muted/40 mt-0.5 shrink-0" />
                Automatic lead document matching — coming in a future phase
              </li>
              <li className="flex items-start gap-2">
                <span className="h-3.5 w-3.5 rounded-full border border-crm-muted/40 mt-0.5 shrink-0" />
                Document import and OCR — coming in a future phase
              </li>
              <li className="flex items-start gap-2">
                <span className="h-3.5 w-3.5 rounded-full border border-crm-muted/40 mt-0.5 shrink-0" />
                AI-assisted summaries and phone extraction — coming in a future phase
              </li>
            </ul>
          </CRMCard>

        </div>
      )}
    </CRMPageShell>
  );
}
