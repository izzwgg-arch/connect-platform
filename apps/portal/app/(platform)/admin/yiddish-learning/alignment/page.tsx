"use client";
/**
 * Yiddish Learning Engine — Alignment viewer (mockup screen 4).
 *
 *  GET /admin/yiddish/sources            → pick a source
 *  GET /admin/yiddish/sources/:key/items → pick an item
 *  GET /admin/yiddish/items/:id          → item + assets + segments + transcripts
 *
 * ⛔ Nothing is drawn that the engine did not measure. If an item has no
 *    aligned tokens, the lanes are not sketched "for illustration" — the page
 *    says there is no alignment and why (audio stages blocked, not processed).
 * ⛔ Yiddish tokens are rendered from the transcript the API returned.
 */
import { useMemo, useState } from "react";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { useAppContext } from "../../../../../hooks/useAppContext";
import {
  Card,
  EmptyState,
  ErrorCard,
  GovernanceChip,
  LoadingCard,
  OwnerOnlyNotice,
  PageHead,
  TableWrap,
  YC_API_PREFIX,
  YiddishPage,
  YiddishText,
  listFrom,
  num,
  titleCase,
  useApi,
  type YcSourceSummary,
} from "../YiddishUi";

type Item = {
  id: string;
  title?: string | null;
  state?: string | null;
  durationSeconds?: number | null;
  governanceClass?: string | null;
  hasAudio?: boolean;
};
type Token = {
  word?: string | null;
  text?: string | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
  confidence?: number | null;
};
type Transcript = {
  id: string;
  engine?: string | null;
  provider?: string | null;
  text?: string | null;
  meanConfidence?: number | null;
  tokens?: Token[];
  isConsensus?: boolean;
};
type Segment = {
  id: string;
  kind?: string | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
  label?: string | null;
};
type Asset = { id: string; kind?: string | null; durationSeconds?: number | null; sampleRateHz?: number | null; available?: boolean; blockedReason?: string | null };
type ItemDetail = {
  item?: Item;
  assets?: Asset[];
  segments?: Segment[];
  transcripts?: Transcript[];
  audioBlockedReason?: string | null;
};

const LOW_CONFIDENCE = 0.5;

export default function AlignmentViewerPage() {
  const { role } = useAppContext();
  const [sourceKey, setSourceKey] = useState("");
  const [itemId, setItemId] = useState("");
  const [selectedToken, setSelectedToken] = useState<Token | null>(null);

  const sources = useApi<YcSourceSummary[] | { sources: YcSourceSummary[] }>(`${YC_API_PREFIX}/sources`);
  const items = useApi<{ items?: Item[]; rows?: Item[] }>(
    sourceKey ? `${YC_API_PREFIX}/sources/${encodeURIComponent(sourceKey)}/items?limit=50` : null,
  );
  const detail = useApi<ItemDetail>(itemId ? `${YC_API_PREFIX}/items/${encodeURIComponent(itemId)}` : null);

  const sourceList = listFrom<YcSourceSummary>(sources.data, "sources");
  const itemList = listFrom<Item>(items.data?.items ?? items.data?.rows ?? items.data, "items");

  const sourceOptions = useMemo(
    () => [{ value: "", label: "Choose a source…" }, ...sourceList.map((s) => ({ value: s.key, label: `${s.name} (${num(s.itemCount)} items)` }))],
    [sourceList],
  );
  const itemOptions = useMemo(
    () => [
      { value: "", label: itemList.length ? "Choose an item…" : "No items in this source" },
      ...itemList.map((i) => ({ value: i.id, label: i.title?.trim() ? i.title : i.id })),
    ],
    [itemList],
  );

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Alignment viewer" />;

  const selectedSource = sourceList.find((s) => s.key === sourceKey) || null;

  return (
    <YiddishPage>
      <PageHead
        title="Audio / transcript alignment"
        subtitle="Word timings, confidence and acoustic lanes for one asset. Ambiguous alignments are flagged, never forced into rules."
      />

      <Card title="Pick an item">
        {sources.loading && sources.data == null ? (
          <div className="skel" style={{ height: 60 }} />
        ) : sources.error ? (
          <ErrorCard error={sources.error} what="The source list" onRetry={sources.reload} />
        ) : (
          <div className="form">
            <div className="field">
              <label htmlFor="al-src">Source</label>
              <ConnectSelect
                id="al-src"
                value={sourceKey}
                onChange={(v) => {
                  setSourceKey(v);
                  setItemId("");
                  setSelectedToken(null);
                }}
                options={sourceOptions}
                ariaLabel="Source"
              />
            </div>
            <div className="field">
              <label htmlFor="al-item">Item</label>
              <ConnectSelect
                id="al-item"
                value={itemId}
                onChange={(v) => {
                  setItemId(v);
                  setSelectedToken(null);
                }}
                options={itemOptions}
                disabled={!sourceKey || items.loading}
                ariaLabel="Item"
              />
            </div>
          </div>
        )}

        {selectedSource ? (
          <div className="row" style={{ marginTop: 10 }}>
            <GovernanceChip value={selectedSource.governanceClass} />
            {selectedSource.audioBlockedReason ? (
              <span className="pill bad" title={selectedSource.audioBlockedReason}>
                Audio stages blocked
              </span>
            ) : (
              <span className="pill ok">Audio stages permitted</span>
            )}
          </div>
        ) : null}
        {selectedSource?.audioBlockedReason ? <div className="blocked-why">⛔ {selectedSource.audioBlockedReason}</div> : null}
        {sourceKey && items.error ? <ErrorCard error={items.error} what="The item list" onRetry={items.reload} /> : null}
      </Card>

      {!itemId ? (
        <Card>
          <EmptyState
            title="No item selected"
            text="Choose a source and an item above. Nothing is drawn until the engine has been asked about a real item."
          />
        </Card>
      ) : detail.loading && detail.data == null ? (
        <LoadingCard rows={5} label="Loading the item" />
      ) : detail.error ? (
        <ErrorCard error={detail.error} what="This item" onRetry={detail.reload} />
      ) : (
        <ItemBody detail={detail.data ?? {}} selectedToken={selectedToken} onSelectToken={setSelectedToken} />
      )}
    </YiddishPage>
  );
}

function secs(v: number | null | undefined): string {
  return v == null ? "—" : `${Number(v).toFixed(2)} s`;
}

function ItemBody({
  detail,
  selectedToken,
  onSelectToken,
}: {
  detail: ItemDetail;
  selectedToken: Token | null;
  onSelectToken: (t: Token | null) => void;
}) {
  const item: Item = detail.item ?? ({ id: "" } as Item);
  const assets = detail.assets ?? [];
  const segments = detail.segments ?? [];
  const transcripts = detail.transcripts ?? [];
  const primary = transcripts.find((t) => t.isConsensus) ?? transcripts[0] ?? null;
  const tokens = primary?.tokens ?? [];
  const duration = Number(item.durationSeconds ?? assets[0]?.durationSeconds ?? 0);

  return (
    <>
      <Card
        title={item.title?.trim() ? item.title : item.id || "Item"}
        sub={`${item.durationSeconds == null ? "Duration not reported" : secs(item.durationSeconds)} · state ${titleCase(item.state)}`}
        right={<GovernanceChip value={item.governanceClass} />}
      >
        {detail.audioBlockedReason ? <div className="banner bad" style={{ marginBottom: 12 }}>⛔ {detail.audioBlockedReason}</div> : null}
        {assets.length === 0 ? (
          <EmptyState title="No assets" text="The engine holds no audio asset for this item, so there is nothing to align." />
        ) : (
          <TableWrap>
            <table className="t">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Kind</th>
                  <th className="num">Duration</th>
                  <th className="num">Sample rate</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id}>
                    <td className="mono small">{a.id}</td>
                    <td>{titleCase(a.kind)}</td>
                    <td className="num">{secs(a.durationSeconds)}</td>
                    <td className="num">{a.sampleRateHz == null ? "—" : `${num(a.sampleRateHz)} Hz`}</td>
                    <td>
                      {a.available === false ? (
                        <span className="pill bad" title={a.blockedReason || "Not available"}>
                          {a.blockedReason || "Not available"}
                        </span>
                      ) : (
                        <span className="pill ok">Stored</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Card>

      <div className="g2">
        <Card
          title="Tokens with word timings"
          sub={`Dashed = alignment confidence below ${LOW_CONFIDENCE.toFixed(2)} — ambiguous, and never used for a rule.`}
        >
          {tokens.length === 0 ? (
            <EmptyState
              title="No aligned tokens"
              text="This item has no word-level alignment. Alignment is an audio stage; it runs only once the audio stages are permitted and the item has been processed."
            />
          ) : (
            <>
              <div className="tokens">
                {tokens.map((t, i) => {
                  const low = t.confidence != null && t.confidence < LOW_CONFIDENCE;
                  const on = selectedToken === t;
                  return (
                    <button
                      key={`${t.startSeconds ?? i}-${i}`}
                      type="button"
                      className={`tok${low ? " low" : ""}${on ? " on" : ""}`}
                      onClick={() => onSelectToken(on ? null : t)}
                    >
                      <YiddishText text={t.word ?? t.text} />
                    </button>
                  );
                })}
              </div>
              <div className="small dimtx" style={{ marginTop: 10 }}>
                {selectedToken ? (
                  <>
                    <YiddishText text={selectedToken.word ?? selectedToken.text} /> · {secs(selectedToken.startSeconds)} →{" "}
                    {secs(selectedToken.endSeconds)} · confidence{" "}
                    {selectedToken.confidence == null ? "not reported" : selectedToken.confidence.toFixed(2)}
                  </>
                ) : (
                  "Select a token to see its timing and confidence."
                )}
              </div>
            </>
          )}
        </Card>

        <Card title="Acoustic segments" sub="Speech, music and silence lanes as the engine measured them.">
          {segments.length === 0 ? (
            <EmptyState title="No segments" text="No segmentation exists for this item." />
          ) : (
            <TableWrap>
              <table className="t">
                <thead>
                  <tr>
                    <th>Kind</th>
                    <th>Label</th>
                    <th className="num">Start</th>
                    <th className="num">End</th>
                    <th className="num">Length</th>
                  </tr>
                </thead>
                <tbody>
                  {segments.map((s) => (
                    <tr key={s.id}>
                      <td>{titleCase(s.kind)}</td>
                      <td className="small">{s.label || "—"}</td>
                      <td className="num">{secs(s.startSeconds)}</td>
                      <td className="num">{secs(s.endSeconds)}</td>
                      <td className="num">
                        {s.startSeconds == null || s.endSeconds == null ? "—" : secs(Number(s.endSeconds) - Number(s.startSeconds))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          {duration > 0 ? <div className="small dimtx" style={{ marginTop: 8 }}>Item length {secs(duration)}.</div> : null}
        </Card>
      </div>

      <Card
        title="Transcripts of this audio"
        sub="Every transcript is kept. Consensus is a property the engine computes; it is shown, never assumed."
      >
        {transcripts.length === 0 ? (
          <EmptyState title="No transcripts" text="Nothing has transcribed this item." />
        ) : (
          <div className="g3">
            {transcripts.map((t) => (
              <div className="lcard" key={t.id}>
                <div className="lcard-h">
                  <div>
                    <h3>{t.engine || t.provider || "Transcript"}</h3>
                    <div className="sub">
                      mean confidence {t.meanConfidence == null ? "not reported" : t.meanConfidence.toFixed(2)}
                    </div>
                  </div>
                  {t.isConsensus ? <span className="pill ok">Consensus</span> : null}
                </div>
                <YiddishText text={t.text} block />
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
