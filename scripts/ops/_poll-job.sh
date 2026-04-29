#!/usr/bin/env bash
sleep 90
curl -s http://127.0.0.1:3910/ops/deploy/jobs/ef288d64-e3c9-4f6c-8ebd-7210d2c390d8 \
  | python3 -c "import json,sys; j=json.load(sys.stdin)['job']; print('status:', j['status'], '| stage:', j.get('currentStage'), '| error:', j.get('errorMessage'))"
