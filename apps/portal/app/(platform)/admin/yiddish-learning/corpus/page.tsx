"use client";
/**
 * Yiddish Learning Engine — Corpus Explorer + word/phrase detail
 * (mockup screens 2 and 3).
 *
 *  GET /admin/yiddish/corpus/search ?q&governance&tier&hasAudio&provider
 *  GET /admin/yiddish/lexemes        ?q&origin&minFrequency&limit
 *  GET /admin/yiddish/lexemes/:id    → lexeme + variants + observations + rules
 *
 * ⛔ Customer-private rows are never searched and never displayed. The wall
 *    card on this page shows COUNTS ONLY, straight from the dashboard payload.
 * ⛔ Every Yiddish string on this page came out of the API and is rendered
 *    through <YiddishText>. Nothing is typed by us.
 */
import { useMemo, useState } from "react";
import { ConnectSelect } from "../../../../../components/ConnectSelect";
import { useAppContext } from "../../../../../hooks/useAppContext";
import {
  Card,
  CustomerWallCard,
  EligibilityChip,
  EmptyState,
  ErrorCard,
  GovernanceChip,
  LoadingCard,
  Modal,
  OwnerOnlyNotice,
  PageHead,
  Resource,
  ServingOnlyChip,
  TableWrap,
  YC_API_PREFIX,
  YiddishPage,
  YiddishText,
  listFrom,
  num,
  pct,
  titleCase,
  useApi,
  type YcDashboardView,
  type YcVariantScore,
} from "../YiddishUi";

/* ── shapes consumed from the engine (defensive: every field optional) ── */

type CorpusRow = {
  id: string;
  text?: string | null;
  sourceKey?: string | null;
  sourceName?: string | null;
  governanceClass?: string | null;
  trainingExportEligibility?: string | null;
  contentAllowed?: boolean;
  ylDerived?: boolean;
  tier?: string | null;
  hasAudio?: boolean;
  hasTranscript?: boolean;
  hasTranslation?: boolean;
  provider?: string | null;
  originRef?: string | null;
};
type CorpusSearchResponse = {
  rows?: CorpusRow[];
  results?: CorpusRow[];
  total?: number;
  sources?: { key: string; name: string }[];
  providers?: string[];
};

type LexemeRow = {
  id: string;
  lemma?: string | null;
  text?: string | null;
  origin?: string | null;
  frequency?: number | null;
  variantCount?: number | null;
  ruleStatus?: string | null;
};
type LexemeListResponse = { lexemes?: LexemeRow[]; rows?: LexemeRow[]; total?: number };

type LexemeObservation = {
  id: string;
  realization?: string | null;
  speakerCluster?: string | null;
  sourceKey?: string | null;
  context?: string | null;
  confidence?: number | null;
  kind?: string | null;
};
type LexemeRule = {
  id: string;
  realization?: string | null;
  ipa?: string | null;
  status?: string | null;
  method?: string | null;
  approvedBy?: string | null;
};
type LexemeDetail = {
  lexeme?: LexemeRow;
  variants?: YcVariantScore[];
  observations?: LexemeObservation[];
  rules?: LexemeRule[];
  evidenceBySource?: { sourceKey: string; weight?: number | null; obs?: number | null; speakers?: number | null; trainingExportEligibility?: string | null; governanceClass?: string | null }[];
};

const GOVERNANCE_OPTIONS = [
  { value: "", label: "Any class" },
  { value: "PLATFORM", label: "Platform" },
  { value: "EXTERNAL", label: "External" },
];
const TIER_OPTIONS = [
  { value: "", label: "Any tier" },
  { value: "A", label: "A — human verified" },
  { value: "B", label: "B — reliable transcript" },
  { value: "C", label: "C — text + translation" },
  { value: "D", label: "D — raw audio" },
  { value: "E", label: "E — unverified" },
];
const HAS_AUDIO_OPTIONS = [
  { value: "", label: "Any" },
  { value: "1", label: "Has audio" },
  { value: "0", label: "No audio" },
];
const ORIGIN_OPTIONS = [
  { value: "", label: "Any origin" },
  ...["YI", "HE", "EN", "NAME", "PLACE", "BUSINESS", "TECH", "PHONE", "ACRONYM", "NUMBER"].map((o) => ({ value: o, label: o })),
];

export default function CorpusExplorerPage() {
  const { role } = useAppContext();
  const [q, setQ] = useState("");
  const [governance, setGovernance] = useState("");
  const [tier, setTier] = useState("");
  const [hasAudio, setHasAudio] = useState("");
  const [provider, setProvider] = useState("");
  const [origin, setOrigin] = useState("");
  const [applied, setApplied] = useState(0);
  const [openLexeme, setOpenLexeme] = useState<LexemeRow | null>(null);

  const corpusPath = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (governance) p.set("governance", governance);
    if (tier) p.set("tier", tier);
    if (hasAudio) p.set("hasAudio", hasAudio);
    if (provider) p.set("provider", provider);
    const qs = p.toString();
    return `${YC_API_PREFIX}/corpus/search${qs ? `?${qs}` : ""}`;
    // `applied` forces a re-read when the operator presses Search with the
    // same filters — the corpus changes underneath them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, governance, tier, hasAudio, provider, applied]);

  const lexemePath = useMemo(() => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (origin) p.set("origin", origin);
    p.set("limit", "50");
    return `${YC_API_PREFIX}/lexemes?${p.toString()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, origin, applied]);

  const corpus = useApi<CorpusSearchResponse>(corpusPath);
  const lexemes = useApi<LexemeListResponse>(lexemePath);
  const dash = useApi<YcDashboardView>(`${YC_API_PREFIX}/dashboard`);

  if (role !== "SUPER_ADMIN") return <OwnerOnlyNotice title="Corpus Explorer" />;

  const providerOptions = [
    { value: "", label: "Any provider" },
    ...(corpus.data?.providers ?? []).map((p) => ({ value: p, label: p })),
  ];

  return (
    <YiddishPage>
      <PageHead
        title="Corpus Explorer"
        subtitle="Every corpus record points back at its original row or URL. The corpus references originals; it never overwrites them."
      />

      <Card title="Search" sub="Literal search over the written form. Customer-private sources are not searched at all.">
        <div className="form">
          <label className="field full">
            <span>Literal search (exact written form)</span>
            <input
              className="linput yi"
              dir="rtl"
              lang="yi"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") setApplied((n) => n + 1);
              }}
              aria-label="Literal search"
            />
            <div className="help">
              Type or paste the written form. Semantic search is not available: it needs pgvector, which the platform&apos;s
              Postgres image does not ship.
            </div>
          </label>
          <div className="field">
            <label htmlFor="yc-gov">Governance class</label>
            <ConnectSelect id="yc-gov" value={governance} onChange={setGovernance} options={GOVERNANCE_OPTIONS} ariaLabel="Governance class" />
            <div className="help">Customer-private is not offered — those rows are never searched.</div>
          </div>
          <div className="field">
            <label htmlFor="yc-tier">Quality tier</label>
            <ConnectSelect id="yc-tier" value={tier} onChange={setTier} options={TIER_OPTIONS} ariaLabel="Quality tier" />
          </div>
          <div className="field">
            <label htmlFor="yc-audio">Audio</label>
            <ConnectSelect id="yc-audio" value={hasAudio} onChange={setHasAudio} options={HAS_AUDIO_OPTIONS} ariaLabel="Has audio" />
          </div>
          <div className="field">
            <label htmlFor="yc-prov">Provider</label>
            <ConnectSelect id="yc-prov" value={provider} onChange={setProvider} options={providerOptions} ariaLabel="Provider" />
          </div>
          <div className="field">
            <label htmlFor="yc-origin">Lexeme origin</label>
            <ConnectSelect id="yc-origin" value={origin} onChange={setOrigin} options={ORIGIN_OPTIONS} ariaLabel="Lexeme origin" />
          </div>
          <div className="field full">
            <button className="lbtn primary" onClick={() => setApplied((n) => n + 1)}>
              Search
            </button>
          </div>
        </div>
      </Card>

      <Card
        title="Corpus records"
        sub={corpus.data?.total != null ? `${num(corpus.data.total)} matching records` : undefined}
      >
        {corpus.loading && corpus.data == null ? (
          <div className="skel" style={{ height: 120 }} />
        ) : corpus.error ? (
          <ErrorCard error={corpus.error} what="Corpus search" onRetry={corpus.reload} />
        ) : (
          <CorpusRows rows={listFrom<CorpusRow>(corpus.data?.rows ?? corpus.data?.results ?? corpus.data, "rows")} />
        )}
      </Card>

      <Card
        title="Words & phrases"
        sub="A lexeme is what the engine has heard. An observation is never a rule — open one to see its evidence."
      >
        {lexemes.loading && lexemes.data == null ? (
          <div className="skel" style={{ height: 120 }} />
        ) : lexemes.error ? (
          <ErrorCard error={lexemes.error} what="The lexicon" onRetry={lexemes.reload} />
        ) : (
          <LexemeRows rows={listFrom<LexemeRow>(lexemes.data?.lexemes ?? lexemes.data?.rows ?? lexemes.data, "lexemes")} onOpen={setOpenLexeme} />
        )}
      </Card>

      <Resource state={dash} what="The customer data wall" skeletonRows={2}>
        {(d) => <CustomerWallCard rows={Array.isArray(d.walled) ? d.walled : []} />}
      </Resource>

      {openLexeme ? <LexemeDrawer row={openLexeme} onClose={() => setOpenLexeme(null)} /> : null}
    </YiddishPage>
  );
}

function CorpusRows({ rows }: { rows: CorpusRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No corpus records match"
        text="Nothing in the searchable corpus matches these filters. Customer-private sources are not searched at all, so no match count is computed for them."
      />
    );
  }
  return (
    <TableWrap>
      <table className="t">
        <thead>
          <tr>
            <th>Text</th>
            <th>Source</th>
            <th>Class</th>
            <th>Training use</th>
            <th>Tier</th>
            <th>Has</th>
            <th>Provider</th>
            <th>Origin (provenance)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ maxWidth: 360 }}>
                <YiddishText text={r.text} block />
              </td>
              <td>
                {r.sourceName || r.sourceKey || "—"}
                {r.ylDerived ? (
                  <span className="sub">
                    <ServingOnlyChip />
                  </span>
                ) : null}
              </td>
              <td>
                <GovernanceChip value={r.governanceClass} />
              </td>
              <td>
                <EligibilityChip value={r.trainingExportEligibility} />
              </td>
              <td>{r.tier || "—"}</td>
              <td className="small dimtx">
                {[r.hasAudio ? "audio" : null, r.hasTranscript ? "transcript" : null, r.hasTranslation ? "translation" : null]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </td>
              <td className="small">{r.provider || "—"}</td>
              <td className="mono small">{r.originRef || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

function LexemeRows({ rows, onOpen }: { rows: LexemeRow[]; onOpen: (r: LexemeRow) => void }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="The lexicon is empty for this search"
        text="No lexeme matches. The engine records a lexeme only once it has been observed in processed material."
      />
    );
  }
  return (
    <TableWrap>
      <table className="t">
        <thead>
          <tr>
            <th>Word / phrase</th>
            <th>Origin</th>
            <th className="num">Frequency</th>
            <th className="num">Variants</th>
            <th>Rule</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <YiddishText text={r.lemma ?? r.text} />
              </td>
              <td>{r.origin || "—"}</td>
              <td className="num">{num(r.frequency)}</td>
              <td className="num">{num(r.variantCount)}</td>
              <td>{r.ruleStatus ? <span className="pill dim">{titleCase(r.ruleStatus)}</span> : <span className="dimtx small">None</span>}</td>
              <td>
                <button className="lbtn sm" onClick={() => onOpen(r)}>
                  Evidence
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** Screen 3 — the word / phrase detail, opened over the explorer. */
function LexemeDrawer({ row, onClose }: { row: LexemeRow; onClose: () => void }) {
  const state = useApi<LexemeDetail>(`${YC_API_PREFIX}/lexemes/${encodeURIComponent(row.id)}`);
  return (
    <Modal title="Word / phrase evidence" onClose={onClose}>
      <div className="ylx">
        <div style={{ marginBottom: 12 }}>
          <YiddishText text={row.lemma ?? row.text} className="big" block />
          <div className="small dimtx" style={{ marginTop: 4 }}>
            Origin {row.origin || "unknown"} · an observation is never a rule; a rule needs evidence above threshold and, for
            high-impact origins, a named human approver.
          </div>
        </div>

        {state.loading && state.data == null ? (
          <LoadingCard rows={3} label="Loading evidence" />
        ) : state.error ? (
          <ErrorCard error={state.error} what="The evidence for this word" onRetry={state.reload} />
        ) : (
          <>
            <div className="seclbl">Variants</div>
            {(state.data?.variants ?? []).length === 0 ? (
              <EmptyState title="No variants recorded" text="Nothing has been observed for this word yet." />
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Variant</th>
                      <th>Realization</th>
                      <th className="num">Share</th>
                      <th className="num">Score</th>
                      <th className="num">Speakers</th>
                      <th>Rule eligible</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(state.data?.variants ?? []).map((v) => (
                      <tr key={v.variantKey}>
                        <td className="mono small">{v.variantKey}</td>
                        <td className="mono small">{v.realization || "—"}</td>
                        <td className="num">{pct(v.share, 1)}</td>
                        <td className="num">{v.score == null ? "—" : v.score.toFixed(2)}</td>
                        <td className="num">{num(v.support?.speakers)}</td>
                        <td>
                          {v.eligibleForRule ? (
                            <span className="pill ok">Eligible</span>
                          ) : (
                            <span className="pill dim" title={v.blockedReason || "No reason reported"}>
                              {v.blockedReason || "Not eligible"}
                            </span>
                          )}
                          {v.humanConfirmed ? <span className="pill info" style={{ marginLeft: 6 }}>Human confirmed</span> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}

            <div className="seclbl" style={{ marginTop: 14 }}>
              Evidence by source
            </div>
            {(state.data?.evidenceBySource ?? []).length === 0 ? (
              <span className="dimtx small">The engine reported no per-source breakdown for this word.</span>
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Class</th>
                      <th>Training use</th>
                      <th className="num">Observations</th>
                      <th className="num">Speakers</th>
                      <th className="num">Weight</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(state.data?.evidenceBySource ?? []).map((e) => (
                      <tr key={e.sourceKey}>
                        <td>{e.sourceKey}</td>
                        <td>
                          <GovernanceChip value={e.governanceClass} />
                        </td>
                        <td>
                          <EligibilityChip value={e.trainingExportEligibility} />
                        </td>
                        <td className="num">{num(e.obs)}</td>
                        <td className="num">{num(e.speakers)}</td>
                        <td className="num">{e.weight == null ? "—" : e.weight}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}

            <div className="seclbl" style={{ marginTop: 14 }}>
              Pronunciation observations — &ldquo;we heard this&rdquo;
            </div>
            {(state.data?.observations ?? []).length === 0 ? (
              <span className="dimtx small">No observations. Nothing has been heard for this word.</span>
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Realization</th>
                      <th>Speaker</th>
                      <th>Source</th>
                      <th>Context</th>
                      <th className="num">Conf</th>
                      <th>Kind</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(state.data?.observations ?? []).map((o) => (
                      <tr key={o.id}>
                        <td className="mono small">{o.realization || "—"}</td>
                        <td className="small">{o.speakerCluster || "—"}</td>
                        <td className="small">{o.sourceKey || "—"}</td>
                        <td className="small">{o.context || "—"}</td>
                        <td className="num">{o.confidence == null ? "—" : o.confidence.toFixed(2)}</td>
                        <td className="small">{titleCase(o.kind)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}

            <div className="seclbl" style={{ marginTop: 14 }}>
              Rules — &ldquo;we apply this&rdquo;
            </div>
            {(state.data?.rules ?? []).length === 0 ? (
              <span className="dimtx small">No rule has been created for this word.</span>
            ) : (
              <TableWrap>
                <table className="t">
                  <thead>
                    <tr>
                      <th>Realization</th>
                      <th>IPA</th>
                      <th>State</th>
                      <th>Method</th>
                      <th>Approved by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(state.data?.rules ?? []).map((r) => (
                      <tr key={r.id}>
                        <td className="mono small">{r.realization || "—"}</td>
                        <td className="mono small">{r.ipa || "—"}</td>
                        <td>
                          <span className="pill dim">{titleCase(r.status)}</span>
                        </td>
                        <td className="small">{titleCase(r.method)}</td>
                        <td className="small">{r.approvedBy || <span className="dimtx">Not approved</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
