"use client";

import { useCallback, useEffect, useState } from "react";
import { RequireAuth, useAuth } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import { api } from "@/lib/api";
import { Button, Chip, Dialog, Empty, Field, Skeleton, useToast } from "@/components/ui";
import "@/components/recommendations/recommendations.css";

type Experiment = {
  id: string;
  key: string;
  hypothesis: string;
  population: string;
  treatment: string;
  control: string;
  successMetrics: string[];
  guardrailMetrics: string[];
  minSample: number;
  rollbackCriteria: string | null;
  status: "DRAFT" | "RUNNING" | "PAUSED" | "DONE";
  assignmentCount: number;
  startsAt: string | null;
  endsAt: string | null;
};

type Results = {
  experiment: Experiment;
  variants: Record<string, { sampleSize: number; insufficientSample: boolean; success: Record<string, number>; guardrail: Record<string, number> }>;
};

const STATUS_TONE: Record<string, "" | "ok" | "warn" | "bad"> = { DRAFT: "", RUNNING: "ok", PAUSED: "warn", DONE: "" };
const NEXT_STATUS: Record<string, string[]> = { DRAFT: ["RUNNING"], RUNNING: ["PAUSED", "DONE"], PAUSED: ["RUNNING", "DONE"], DONE: [] };

const EMPTY_FORM = { key: "", hypothesis: "", population: "", treatment: "", control: "", successMetrics: "", guardrailMetrics: "", minSample: "100", rollbackCriteria: "" };

export default function AdminExperimentsPage() {
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
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resultsFor, setResultsFor] = useState<Experiment | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ experiments: Experiment[] }>("/admin/experiments");
      setExperiments(r.experiments);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load experiments.", { kind: "err" });
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
      <AppShell title="Experiments">
        <Empty title="Platform staff only" text="This screen is for Loopcom staff." />
      </AppShell>
    );
  }

  async function createExperiment(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await api("/admin/experiments", {
        method: "POST",
        body: {
          key: form.key.trim(),
          hypothesis: form.hypothesis.trim(),
          population: form.population.trim(),
          treatment: form.treatment.trim(),
          control: form.control.trim(),
          successMetrics: form.successMetrics.split(",").map((s) => s.trim()).filter(Boolean),
          guardrailMetrics: form.guardrailMetrics.split(",").map((s) => s.trim()).filter(Boolean),
          minSample: Number(form.minSample) || 100,
          rollbackCriteria: form.rollbackCriteria.trim(),
        },
      });
      toast("Experiment created as a draft.");
      setForm(EMPTY_FORM);
      await load();
    } catch (e: any) {
      toast(e?.message ?? "Couldn't create that experiment.", { kind: "err" });
    } finally {
      setCreating(false);
    }
  }

  async function setStatus(exp: Experiment, status: string) {
    setBusyId(exp.id);
    try {
      await api(`/admin/experiments/${exp.id}`, { method: "PATCH", body: { status } });
      toast(`${exp.key} is now ${status}.`);
      await load();
    } catch (e: any) {
      toast(e?.message ?? "Couldn't change that experiment's status.", { kind: "err" });
    } finally {
      setBusyId(null);
    }
  }

  async function openResults(exp: Experiment) {
    setResultsFor(exp);
    setResultsLoading(true);
    setResults(null);
    try {
      const r = await api<Results>(`/admin/experiments/${exp.id}/results`);
      setResults(r);
    } catch (e: any) {
      toast(e?.message ?? "Couldn't load results.", { kind: "err" });
    } finally {
      setResultsLoading(false);
    }
  }

  return (
    <AppShell title="Experiments">
      <div className="card" data-testid="admin-experiments-new">
        <div className="ct">New experiment</div>
        <form onSubmit={createExperiment} className="list sm">
          <Field label="Key" htmlFor="exp-key" help="A stable id, e.g. reco.byn_ranking_v2">
            <input id="exp-key" className="in" value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} required data-testid="admin-experiments-key" />
          </Field>
          <Field label="Hypothesis" htmlFor="exp-hyp">
            <textarea id="exp-hyp" className="in" rows={2} value={form.hypothesis} onChange={(e) => setForm((f) => ({ ...f, hypothesis: e.target.value }))} required data-testid="admin-experiments-hypothesis" />
          </Field>
          <Field label="Population" htmlFor="exp-pop" help="Who is eligible, e.g. All signed-in members">
            <input id="exp-pop" className="in" value={form.population} onChange={(e) => setForm((f) => ({ ...f, population: e.target.value }))} required data-testid="admin-experiments-population" />
          </Field>
          <div className="grid2">
            <Field label="Treatment" htmlFor="exp-treat" help='Describe the arm; optionally embed a split like "treatment:70"'>
              <input id="exp-treat" className="in" value={form.treatment} onChange={(e) => setForm((f) => ({ ...f, treatment: e.target.value }))} required data-testid="admin-experiments-treatment" />
            </Field>
            <Field label="Control" htmlFor="exp-ctrl">
              <input id="exp-ctrl" className="in" value={form.control} onChange={(e) => setForm((f) => ({ ...f, control: e.target.value }))} required data-testid="admin-experiments-control" />
            </Field>
          </div>
          <div className="grid2">
            <Field label="Success metrics" htmlFor="exp-success" help="Comma-separated analytics event names">
              <input id="exp-success" className="in" value={form.successMetrics} onChange={(e) => setForm((f) => ({ ...f, successMetrics: e.target.value }))} required data-testid="admin-experiments-success-metrics" />
            </Field>
            <Field label="Guardrail metrics" htmlFor="exp-guard" help="Comma-separated analytics event names">
              <input id="exp-guard" className="in" value={form.guardrailMetrics} onChange={(e) => setForm((f) => ({ ...f, guardrailMetrics: e.target.value }))} required data-testid="admin-experiments-guardrail-metrics" />
            </Field>
          </div>
          <div className="grid2">
            <Field label="Minimum sample" htmlFor="exp-minsample">
              <input id="exp-minsample" className="in" type="number" min={1} value={form.minSample} onChange={(e) => setForm((f) => ({ ...f, minSample: e.target.value }))} required data-testid="admin-experiments-min-sample" />
            </Field>
            <Field label="Rollback criteria" htmlFor="exp-rollback">
              <input id="exp-rollback" className="in" value={form.rollbackCriteria} onChange={(e) => setForm((f) => ({ ...f, rollbackCriteria: e.target.value }))} required data-testid="admin-experiments-rollback" />
            </Field>
          </div>
          <Button kind="p" loading={creating} type="submit" data-testid="admin-experiments-create">
            Create as draft
          </Button>
        </form>
      </div>

      <div className="card" data-testid="admin-experiments-list">
        <div className="ct">All experiments</div>
        {loading ? (
          <Skeleton h={120} />
        ) : experiments.length === 0 ? (
          <Empty title="No experiments yet" />
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Key</th>
                <th>Status</th>
                <th>Assigned</th>
                <th>Min sample</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {experiments.map((exp) => (
                <tr key={exp.id} data-testid={`admin-experiments-row-${exp.key}`}>
                  <td>
                    <b className="mono" style={{ fontSize: 12 }}>
                      {exp.key}
                    </b>
                    <br />
                    <small className="dim">{exp.hypothesis}</small>
                  </td>
                  <td>
                    <Chip kind={STATUS_TONE[exp.status]}>{exp.status}</Chip>
                  </td>
                  <td>{exp.assignmentCount}</td>
                  <td>{exp.minSample}</td>
                  <td>
                    <div className="row">
                      {NEXT_STATUS[exp.status].map((s) => (
                        <Button key={s} small loading={busyId === exp.id} onClick={() => setStatus(exp, s)} data-testid={`admin-experiments-set-${exp.key}-${s.toLowerCase()}`}>
                          {s === "RUNNING" ? "Start" : s === "PAUSED" ? "Pause" : s === "DONE" ? "Mark done" : s}
                        </Button>
                      ))}
                      <Button small onClick={() => openResults(exp)} data-testid={`admin-experiments-results-${exp.key}`}>
                        Results
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog open={!!resultsFor} onClose={() => setResultsFor(null)} title={`Results — ${resultsFor?.key ?? ""}`} wide>
        {resultsLoading ? (
          <Skeleton h={100} />
        ) : results ? (
          <div className="grid2">
            {Object.entries(results.variants).map(([variant, data]) => (
              <div className="card tight" key={variant}>
                <div className="ct" style={{ textTransform: "capitalize" }}>
                  {variant}
                  {data.insufficientSample ? <Chip kind="warn">insufficient sample</Chip> : null}
                </div>
                <p className="sm dim">Sample: {data.sampleSize}</p>
                <b className="sm">Success</b>
                <ul>
                  {Object.entries(data.success).map(([m, n]) => (
                    <li key={m}>
                      {m}: {n}
                    </li>
                  ))}
                </ul>
                <b className="sm">Guardrail</b>
                <ul>
                  {Object.entries(data.guardrail).map(([m, n]) => (
                    <li key={m}>
                      {m}: {n}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </Dialog>
    </AppShell>
  );
}
