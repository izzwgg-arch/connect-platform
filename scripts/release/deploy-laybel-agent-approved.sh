#!/usr/bin/env bash
# One-operation owner-approved exception, 2026-09-16: deploy only the Assistant
# for Laybel streaming. The routine queue has no agent target. Not a general
# replacement for deploy-direct.sh. No migrations, config edits or other services.
set -euo pipefail
target="${1:-}"
mode="${2:---dry-run}"
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected full commit SHA'; exit 2; }
[[ "$mode" == --dry-run || "$mode" == --owner-approved ]] || exit 2
root=/opt/connectcomms/app
cd "$root"
git cat-file -e "$target^{commit}"
queue="$(curl -fsS http://127.0.0.1:3910/ops/deploy/status)"
node -e 'const q=JSON.parse(process.argv[1]); if(q.runningCount!==0 || q.queuedCount!==0) process.exit(1)' "$queue"
old_image="$(docker inspect --format '{{.Image}}' app-agent-1)"
[[ "$old_image" == sha256:* ]]
tag="loopcom-agent:laybel-${target:0:12}"
rollback_tag="loopcom-agent:laybel-rollback-${target:0:12}"
echo "[deploy-laybel-agent] target=$target old_image=$old_image mode=$mode"
if [[ "$mode" == --dry-run ]]; then
  echo '[deploy-laybel-agent] Would archive the pinned commit, build the agent image, retain a rollback image, replace only agent with --no-deps, then verify health and source.'
  exit 0
fi
export DEPLOY_QUEUE_ACK=1
exec 9>/tmp/loopcom-laybel-agent-release.lock
flock -n 9 || { echo 'Another Laybel agent release is running'; exit 1; }
stage="$(mktemp -d /tmp/loopcom-laybel-agent.XXXXXX)"
git archive "$target" | tar -x -C "$stage"
docker tag "$old_image" "$rollback_tag"
docker build --build-arg "BUILD_COMMIT=$target" --label "org.opencontainers.image.revision=$target" -f "$stage/apps/agent/Dockerfile" -t "$tag" "$stage"
# Generated compose override stays in the isolated stage, never in env or /etc.
override="$stage/laybel-agent-image.json"
printf '{"services":{"agent":{"image":"%s"}}}\n' "$tag" > "$override"
compose=(docker compose -p app --project-directory "$root" -f "$root/docker-compose.app.yml" -f "$root/docker-compose.agent.yml" -f "$override")
wait_healthy() {
  for attempt in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3920/health >/dev/null; then return 0; fi
    sleep 2
  done
  return 1
}
rollback() {
  trap - ERR
  echo "[deploy-laybel-agent] Rolling back only agent to $rollback_tag"
  printf '{"services":{"agent":{"image":"%s"}}}\n' "$rollback_tag" > "$override"
  "${compose[@]}" up -d --no-deps --no-build --pull never agent
  wait_healthy
  echo '[deploy-laybel-agent] Rollback health verified; requested release FAILED'
  exit 1
}
trap rollback ERR
"${compose[@]}" up -d --no-deps --no-build --pull never agent
wait_healthy
[[ "$(docker exec app-agent-1 printenv BUILD_COMMIT)" == "$target" ]]
docker exec app-agent-1 grep -q 'readFinalSpeech' /app/apps/agent/src/llm/router.ts
docker exec app-agent-1 grep -q 'speech_end' /app/apps/agent/src/conversation/routes.ts
trap - ERR
echo "[deploy-laybel-agent] rollback_image=$rollback_tag source_stage=$stage"
echo "[deploy-agent] done $target requested_by=codex:owner-approved-laybel"
