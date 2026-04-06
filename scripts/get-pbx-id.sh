#!/bin/bash
PGPASSWORD=7d5b4ceaaa74883911a6fb06a3c1b6a6ec8054c507393bab psql -U connectcomms -h localhost -d connectcomms -t -c 'SELECT id FROM "PbxInstance" WHERE "isEnabled"=true LIMIT 1' | tr -d ' \n'
