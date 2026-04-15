# Telephony Test Orchestrator

Automated validation runner for the Connect telephony platform. Runs real tests against live endpoints — no mocked data.

## Requirements

- Must run **on the server** (or with SSH port-forwards to localhost:3001, 9090, 3100, 3003)
- Node.js 18+ with `tsx` available
- Access to Docker socket (for container status / destructive tests)

## Quick Start

```bash
# SSH into the server
ssh root@45.14.194.179

# Navigate to project
cd /opt/connectcomms/app   # or wherever the project is mounted

# Run auto-only mode (no manual calls, no service restarts)
npx tsx scripts/telephony-test-orchestrator/orchestrator.ts

# Run with manual call scenarios
npx tsx scripts/telephony-test-orchestrator/orchestrator.ts --all

# Run with destructive tests (will restart services)
npx tsx scripts/telephony-test-orchestrator/orchestrator.ts --destructive

# Run a single scenario
npx tsx scripts/telephony-test-orchestrator/orchestrator.ts --scenario 2

# CI mode (no prompts, skip manual steps)
npx tsx scripts/telephony-test-orchestrator/orchestrator.ts --ci

# Save JSON report
npx tsx scripts/telephony-test-orchestrator/orchestrator.ts --report /tmp/test-report.json
```

## Scenarios

| # | Name | Mode | Destructive |
|---|------|------|-------------|
| 1 | System Health & Observability Stack | Auto | No |
| 2 | AMI / ARI Connectivity | Auto (+ optional restart) | Optional |
| 3 | Call Metrics & CDR Accuracy | Auto (+ optional manual call) | No |
| 4 | Audio Quality & VoiceDiag | Auto (+ optional WebRTC call) | No |
| 5 | Self-Healing Engine | Auto (+ optional kill test) | Optional |
| 6 | Alert Rules Accuracy | Auto | No |
| 7 | End-to-End Incident Flow | Manual required | No |
| 8 | Loki Log Pipeline | Auto | No |

## Flags

| Flag | Description |
|------|-------------|
| `--all` | Run manual-interaction scenarios (scenarios 3, 4, 7) |
| `--destructive` | Enable tests that temporarily restart services |
| `--scenario N` | Run only scenario N |
| `--ci` | Non-interactive: skip manual prompts, mark as SKIPPED |
| `--no-restore` | Skip service restoration after destructive tests (DEBUG) |
| `--report FILE` | Write full JSON report to file |
| `--api-url URL` | Override Connect API URL (default: http://localhost:3001) |
| `--prom-url URL` | Override Prometheus URL (default: http://localhost:9090) |
| `--loki-url URL` | Override Loki URL (default: http://localhost:3100) |
| `--tele-url URL` | Override Telephony service URL (default: http://localhost:3003) |

## What Gets Tested

### Automatic (no interaction required)
- All service HTTP endpoints respond correctly
- Prometheus scraping both app targets
- 20+ alert rules loaded in 5 groups  
- Loki receiving logs with expected labels
- Grafana has 5+ dashboards provisioned
- AMI connected, ARI healthy, uptime stable
- Active calls / extension metrics accurate
- ICE failure counter exists
- TURN configured metric = 1
- Self-healing engine running and healthy
- Alert rule consistency (TURN alert ↔ TURN metric)
- HighHeapUsage threshold is calibrated
- Alertmanager receiving and routing
- Loki log entries present per service
- Promtail container running

### With `--all` (requires manual browser action)
- Full WebRTC call → quality report submitted → captured in Loki
- Failed call → Ops Center incident detection
- ICE connection state captured correctly in quality report

### With `--destructive` (restarts services temporarily)
- Telephony restart → AMI reconnects within 45s (Scenario 2)
- Telephony stop → Healing engine detects and logs action (Scenario 5)

## Safety

- Destructive tests always run `docker start` in a finally block
- Each test is isolated — failures don't cascade
- A 10s pause separates consecutive destructive tests
- `--no-restore` flag is available for debugging but not recommended

## Output

```
══════════════════════════════════════════════════
SCENARIO 1: SYSTEM HEALTH & OBSERVABILITY STACK
══════════════════════════════════════════════════

   PASS  Connect API /health reachable (34ms)
   PASS  Telephony /health reachable (12ms)
   PASS  Prometheus /-/ready reachable (8ms)
   PASS  Loki /ready reachable (6ms)
   PASS  Alertmanager /-/ready reachable (5ms)
   PASS  Prometheus scrape targets all UP (245ms)
   PASS  Alert rules loaded (89ms)
   PASS  Loki receiving logs (134ms)
   PASS  Grafana dashboards provisioned (67ms)
   PASS  No unexpected alerts firing (56ms)

   PASS  Scenario 1 complete — 10 checks, 0 failed, 0 warned, 0 skipped
```
