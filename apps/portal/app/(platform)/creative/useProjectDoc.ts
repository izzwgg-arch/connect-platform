"use client";
/**
 * Creative Studio — the one editing channel.
 *
 * The storyboard and the video editor are two views of the same kind of thing:
 * a project document with a revision, changed by small operations. The
 * Coworker changes it through exactly the same door (`POST
 * /creative/documents/:id/ops`), which is what makes "the agent edits the same
 * project you do" true rather than a claim.
 *
 * ⛔ The revision is the whole point. A write against a revision that has moved
 * on is refused by the server with the current document attached; when that
 * happens we take the server's copy and say so, rather than overwriting
 * somebody — the person, or the agent working while you had the tab open.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost, apiPut } from "../../../services/apiClient";

export interface DocObject {
  id: string;
  type: string;
  [key: string]: any;
}

export interface EditOp {
  op: "add" | "set" | "move" | "resize" | "replace" | "reorder" | "delete" | "split" | "trim";
  target?: string;
  payload?: any;
  summary?: string;
}

export interface ProjectDoc {
  id: string;
  type: string;
  revision: number;
  doc: { objects?: DocObject[]; [key: string]: any };
}

export interface UseProjectDoc {
  loading: boolean;
  project: any | null;
  projects: any[];
  doc: ProjectDoc | null;
  objects: DocObject[];
  assets: any[];
  jobs: any[];
  error: string;
  /** Somebody else (or the Coworker) changed it while this tab was open. */
  overtaken: boolean;
  reload: () => Promise<void>;
  apply: (ops: EditOp[]) => Promise<boolean>;
  setDocFields: (fields: Record<string, any>) => Promise<boolean>;
}

export function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

/** Loads (or creates) one document of a project and edits it by operations. */
export function useProjectDoc(projectId: string, type: "storyboard" | "timeline" | "canvas", seed: () => any): UseProjectDoc {
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<any | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [doc, setDoc] = useState<ProjectDoc | null>(null);
  const [assets, setAssets] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [overtaken, setOvertaken] = useState(false);
  const creating = useRef(false);

  const reload = useCallback(async () => {
    setError("");
    try {
      if (!projectId) {
        const list: any = await apiGet("/creative/projects?limit=50");
        setProjects(list.projects || []);
        setProject(null);
        setDoc(null);
        return;
      }
      const res: any = await apiGet(`/creative/projects/${projectId}`);
      setProject(res.project || null);
      setAssets(res.assets || []);
      setJobs(res.jobs || []);
      const found = (res.documents || []).find((d: any) => d.type === type);
      if (found) {
        setDoc(found);
      } else if (!creating.current) {
        // First visit: the document is made the moment the page is opened, so
        // there is never a "save this before you can use it" step.
        creating.current = true;
        const made: any = await apiPut(`/creative/projects/${projectId}/documents/${type}`, { doc: seed() });
        setDoc(made.document);
        creating.current = false;
      }
    } catch (e: any) {
      setError(e?.body?.reason || e?.message || "That did not load.");
    } finally {
      setLoading(false);
    }
    // seed is a factory the caller redefines every render; depending on it
    // would reload forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, type]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  const apply = useCallback(
    async (ops: EditOp[]): Promise<boolean> => {
      if (!doc || !ops.length) return false;
      setError("");
      try {
        const res: any = await apiPost(`/creative/documents/${doc.id}/ops`, { baseRevision: doc.revision, actorType: "user", ops });
        setDoc({ ...doc, revision: res.revision, doc: res.doc });
        setOvertaken(false);
        return true;
      } catch (e: any) {
        if (e?.status === 409 && e?.body?.doc) {
          // Not an error the person caused: take the newer copy and let them
          // redo the one change they just made.
          setDoc({ ...doc, revision: e.body.revision, doc: e.body.doc });
          setOvertaken(true);
          return false;
        }
        setError(e?.body?.reason || e?.message || "That change did not save.");
        return false;
      }
    },
    [doc],
  );

  /** Whole-document settings (size, frame rate, whether captions are burned in). */
  const setDocFields = useCallback(
    async (fields: Record<string, any>): Promise<boolean> => {
      if (!doc || !projectId) return false;
      try {
        const res: any = await apiPut(`/creative/projects/${projectId}/documents/${type}`, { doc: { ...doc.doc, ...fields } });
        setDoc(res.document);
        return true;
      } catch (e: any) {
        setError(e?.body?.reason || e?.message || "That change did not save.");
        return false;
      }
    },
    [doc, projectId, type],
  );

  return {
    loading,
    project,
    projects,
    doc,
    objects: Array.isArray(doc?.doc?.objects) ? (doc!.doc.objects as DocObject[]) : [],
    assets,
    jobs,
    error,
    overtaken,
    reload,
    apply,
    setDocFields,
  };
}
