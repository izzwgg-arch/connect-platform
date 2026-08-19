#!/bin/bash
: "${PGPASSWORD:?Set PGPASSWORD to the connectcomms DB password before running. It is intentionally NOT stored in this repo; provide it from your environment.}"
PGPASSWORD=${PGPASSWORD} psql -U connectcomms -h localhost -d connectcomms -t -c 'SELECT id FROM "PbxInstance" WHERE "isEnabled"=true LIMIT 1' | tr -d ' \n'
