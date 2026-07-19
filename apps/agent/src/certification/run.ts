/**
 * Standalone certification runner — `pnpm --filter @connect/agent certify`.
 * Prints a human report and writes JSON + Markdown artifacts. Exit code 1 on
 * any failure so CI / the scheduled driver can gate on it.
 */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { runCertification, type CertReport } from "./harness";

function toMarkdown(r: CertReport): string {
  const lines: string[] = [];
  lines.push(`# Connect Agent — Certification Report`);
  lines.push(`\n_Ran: ${r.ranAt} · mode: ${r.mode}_\n`);
  lines.push(`**${r.passed}/${r.totalCases} cases passed · zero-impact proven: ${r.zeroImpactProven ? "YES" : "NO"}**\n`);
  lines.push(`## By capability\n`);
  lines.push(`| Capability | Passed | Failed | Certified |`);
  lines.push(`|---|---|---|---|`);
  for (const [cap, b] of Object.entries(r.byCapability)) {
    lines.push(`| ${cap} | ${b.passed} | ${b.failed} | ${b.certified ? "✅" : "❌"} |`);
  }
  lines.push(`\n## Cases\n`);
  for (const c of r.cases) lines.push(`- ${c.passed ? "✅" : "❌"} **${c.name}** (${c.capability})${c.detail ? ` — ${c.detail}` : ""}`);
  return lines.join("\n") + "\n";
}

async function main() {
  const report = await runCertification();
  const outDir = process.env.AGENT_CERT_DIR ?? "/var/log/connect-agent";
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "certification-latest.json"), JSON.stringify(report, null, 2));
    await writeFile(path.join(outDir, "certification-latest.md"), toMarkdown(report));
  } catch {
    /* artifact write is best-effort */
  }
  // eslint-disable-next-line no-console
  console.log(toMarkdown(report));
  if (report.failed > 0 || !report.zeroImpactProven) {
    // eslint-disable-next-line no-console
    console.error(`CERTIFICATION FAILED: ${report.failed} case(s) failed, zeroImpact=${report.zeroImpactProven}`);
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
