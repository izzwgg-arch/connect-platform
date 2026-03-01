#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

log(){ echo "[rollback] $*"; }
fail(){ echo "[rollback] FAIL: $*" >&2; exit 1; }

mapfile -t tags < <(git tag --sort=version:refname)
[[ ${#tags[@]} -ge 2 ]] || fail "need at least 2 tags for rollback"

current_tag="$(git tag --points-at HEAD | sort -V | tail -n1 || true)"
if [[ -z "$current_tag" ]]; then
  current_tag="$(git describe --tags --abbrev=0 2>/dev/null || true)"
fi
[[ -n "$current_tag" ]] || fail "cannot determine current tag"

prev_tag=""
for i in "${!tags[@]}"; do
  if [[ "${tags[$i]}" == "$current_tag" ]]; then
    if [[ "$i" -eq 0 ]]; then
      fail "no previous tag before ${current_tag}"
    fi
    prev_tag="${tags[$((i-1))]}"
    break
  fi
done

if [[ -z "$prev_tag" ]]; then
  prev_tag="${tags[$((${#tags[@]}-2))]}"
fi

log "current_tag=${current_tag} previous_tag=${prev_tag}"
exec ./scripts/release/deploy-tag.sh "$prev_tag"
