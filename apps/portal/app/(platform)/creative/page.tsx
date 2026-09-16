"use client";
/**
 * Creative Studio — home.
 *
 * Built from the approved Phase-0 mockup (docs/mockups/creative-studio/,
 * "Creative Studio home"). Gated by can_view_creative_home, which is in no
 * default bucket: granting the key is the launch.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PermissionGate } from "../../../components/PermissionGate";
import { apiGet, apiPost } from "../../../services/apiClient";
import { AssetThumb, Card, CREATE_KINDS, EmptyState, LoadingCard, Note, PageHead, Pill, errText, money } from "./CreativeUi";

export default function CreativeHomePage() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setErr("");
      const res: any = await apiGet("/creative/overview");
      setData(res);
    } catch (e: any) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startProject = async (kind: string, href: string) => {
    setCreating(true);
    try {
      const res: any = await apiPost("/creative/projects", { title: "Untitled", kind });
      router.push(`${href}?project=${encodeURIComponent(res.project.id)}`);
    } catch (e: any) {
      setErr(errText(e));
      setCreating(false);
    }
  };

  const quota = data?.quota;
  const videoLeft = quota ? Math.max(0, quota.videoSeconds - (quota.used?.videoSeconds || 0)) : 0;

  return (
    <PermissionGate
      permission="can_view_creative_home"
      fallback={
        <div className="cse">
          <EmptyState title="Creative Studio isn't on for this account" text="An admin at your company can switch it on." />
        </div>
      }
    >
      <div className="cse">
        <PageHead
          title="Creative Studio"
          subtitle="Make images, videos, graphics and ads with your own brand. Ask the Coworker, or open an editor yourself — both work on the same project."
          actions={
            <>
              <button type="button" className="cse-btn" onClick={() => router.push("/creative/projects")}>
                All projects
              </button>
              <button type="button" className="cse-btn primary" onClick={() => router.push("/creative/images")}>
                Make something
              </button>
            </>
          }
        />

        {err ? <Note kind="bad">{err}</Note> : null}

        {loading ? (
          <LoadingCard rows={3} />
        ) : (
          <>
            <Card
              title="Start something"
              sub="Every one of these can also be asked for in plain English"
              end={quota ? <Pill kind="info">{videoLeft}s of video left this month</Pill> : null}
              className="cse-mb"
            >
              <div className="cse-tiles">
                {CREATE_KINDS.map((k) => (
                  <button key={k.label} type="button" className="cse-tile" disabled={creating} onClick={() => startProject(k.kind, k.href)}>
                    <span className="ti">{k.label.slice(0, 1)}</span>
                    <b>{k.label}</b>
                    <span>{k.hint}</span>
                  </button>
                ))}
              </div>
            </Card>

            <div className="cse-grid g2" style={{ marginTop: 14 }}>
              <Card
                title="Pick up where you left off"
                end={
                  <button type="button" className="cse-btn sm ghost" onClick={() => router.push("/creative/projects")}>
                    All projects
                  </button>
                }
              >
                {data?.projects?.length ? (
                  <div className="cse-stack">
                    {data.projects.map((p: any) => (
                      <button
                        key={p.id}
                        type="button"
                        className="cse-row"
                        style={{ background: "transparent", border: 0, textAlign: "left", cursor: "pointer", padding: 4 }}
                        onClick={() => router.push(`/creative/projects/${p.id}`)}
                      >
                        <div style={{ flex: 1 }}>
                          <b style={{ fontSize: 13 }}>{p.title}</b>
                          <div className="cse-help">
                            {p.kind} · {p.status}
                            {p.spentMicros ? ` · ${money(p.spentMicros)}` : ""}
                          </div>
                        </div>
                        <Pill kind={p.status === "done" ? "ok" : p.status === "working" ? "warn" : "nub"}>{p.status}</Pill>
                      </button>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    title="Nothing here yet"
                    text="Make your first image, video or design — or ask the Coworker for one."
                    action={
                      <button type="button" className="cse-btn primary sm" onClick={() => router.push("/creative/images")}>
                        Make an image
                      </button>
                    }
                  />
                )}
              </Card>

              <Card title="Recent generations" sub="Everything the studio made, newest first">
                {data?.recent?.length ? (
                  <div className="cse-rowscroll">
                    {data.recent.map((a: any) => (
                      <div key={a.id} style={{ width: 150 }}>
                        <AssetThumb asset={a} />
                        <div className="cse-help" style={{ marginTop: 4 }}>
                          {a.kind === "video" ? "Video" : "Image"}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="No generations yet" text="What you make will appear here." />
                )}
              </Card>
            </div>

            <div className="cse-grid g3" style={{ marginTop: 14 }}>
              <Card title="Brand kit" end={<button type="button" className="cse-btn sm ghost" onClick={() => router.push("/creative/brand")}>Open</button>}>
                {data?.brandKit ? (
                  <div className="cse-stack" style={{ gap: 6 }}>
                    <b style={{ fontSize: 13 }}>{data.brandKit.name}</b>
                    <span className="cse-help">{data.brandKit.itemCount} things saved · used by everything you make</span>
                  </div>
                ) : (
                  <div className="cse-stack" style={{ gap: 8 }}>
                    <span className="cse-help">Add your logo, colours and fonts once and everything comes out on brand.</span>
                    <button type="button" className="cse-btn sm" onClick={() => router.push("/creative/brand")}>
                      Set up the brand kit
                    </button>
                  </div>
                )}
              </Card>

              <Card title="What is switched on">
                <div className="cse-stack" style={{ gap: 6 }}>
                  {[
                    ["Images", data?.capabilities?.image],
                    ["Video", data?.capabilities?.video],
                    ["Voiceover", data?.capabilities?.speech],
                    ["Music", data?.capabilities?.music],
                  ].map(([label, on]: any) => (
                    <div key={label} className="cse-row">
                      <span style={{ flex: 1, fontSize: 12.5 }}>{label}</span>
                      <Pill kind={on ? "ok" : "nub"}>{on ? "ready" : "off"}</Pill>
                    </div>
                  ))}
                </div>
              </Card>

              <Card title="This month" end={<button type="button" className="cse-btn sm ghost" onClick={() => router.push("/creative/memory")}>Memory</button>}>
                {quota ? (
                  <div className="cse-stack" style={{ gap: 8 }}>
                    <div>
                      <div className="cse-row">
                        <span style={{ fontSize: 12.5 }}>Video</span>
                        <span className="cse-num cse-muted" style={{ marginLeft: "auto" }}>
                          {quota.used?.videoSeconds || 0} / {quota.videoSeconds}s
                        </span>
                      </div>
                      <div className="cse-bar">
                        <i style={{ width: `${Math.min(100, ((quota.used?.videoSeconds || 0) / Math.max(1, quota.videoSeconds)) * 100)}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="cse-row">
                        <span style={{ fontSize: 12.5 }}>Images</span>
                        <span className="cse-num cse-muted" style={{ marginLeft: "auto" }}>
                          {quota.used?.images || 0} / {quota.images}
                        </span>
                      </div>
                      <div className="cse-bar">
                        <i style={{ width: `${Math.min(100, ((quota.used?.images || 0) / Math.max(1, quota.images)) * 100)}%` }} />
                      </div>
                    </div>
                  </div>
                ) : null}
              </Card>
            </div>
          </>
        )}
      </div>
    </PermissionGate>
  );
}
