#!/usr/bin/env ts-node
/**
 * Safe deploy-log summarizer
 *
 * Usage: ts-node scripts/summarize-deploy-log.ts /path/to/deploy.log
 * Output: single-line JSON summary with redaction applied
 */
import fs from 'fs';
import path from 'path';
import { sanitizeDiagnosticOutput } from '../apps/api/src/utils/safeDiagnosticRedaction';

function parseSummary(text: string) {
  const lines = text.split(/\r?\n/);
  let service: string | null = null;
  let commit: string | null = null;
  let status: string | null = null;
  let lastStage: string | null = null;
  const timing: Record<string, number> = {};
  let health: 'ok' | 'fail' | 'unknown' = 'unknown';

  for (const raw of lines) {
    const line = raw.trim();
    const svcMatch = line.match(/^\[(deploy-[a-z0-9_-]+)\]/i);
    if (svcMatch && !service) {
      const tag = svcMatch[1];
      const m2 = tag.match(/^deploy-([a-z0-9_-]+)/i);
      if (m2) service = m2[1];
    }
    const doneMatch = line.match(/^\[deploy-[^\]]+\]\s+done\s+([0-9a-f]{7,40})\b/i);
    if (doneMatch) {
      commit = doneMatch[1];
      status = 'success';
    }
    const stageMatch = line.match(/^\[deploy-common\]\s+stage=([a-z]+)/i);
    if (stageMatch) lastStage = stageMatch[1].toLowerCase();

    const timeMatch = line.match(/^\[timing\]\s+([a-z_]+)=(\d+)ms$/i);
    if (timeMatch) timing[timeMatch[1].toLowerCase()] = parseInt(timeMatch[2], 10);

    if (/\bhealth check\b/i.test(line)) {
      health = 'ok'; // paired with stage=done implies ok; we avoid echoing URLs
    }
  }

  const branch: string | null = null; // Not present in logs reliably; avoid guessing

  return {
    service: service ?? 'unknown',
    branch: branch ?? 'unknown',
    commit: commit ?? 'unknown',
    status: status ?? (lastStage === 'done' ? 'success' : 'unknown'),
    stage: lastStage ?? 'unknown',
    timing,
    health,
  };
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: summarize-deploy-log.ts <log-file>');
    process.exit(2);
  }
  const text = fs.readFileSync(path.resolve(file), 'utf8');
  // Strip very long absolute paths aggressively before parsing
  const stripped = text.replace(/(?:[A-Za-z]:\\|\/)\S{60,}/g, '[PATH]');
  const summary = parseSummary(stripped);
  const json = JSON.stringify(summary);
  // Final pass through sanitizer to guarantee no sensitive fragments leak
  const safe = sanitizeDiagnosticOutput(json);
  process.stdout.write(safe + '\n');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('summarize-deploy-log: error'); process.exit(1); }
}
