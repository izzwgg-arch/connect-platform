#!/usr/bin/env node
'use strict';
/*
 * connect-cli.js — command-line front end for the Connect automation library.
 * Everything defaults to a safe DRY RUN; real changes require --commit.
 *
 *   node connect-cli.js pool               # show how many robot accounts are loaded (no login)
 *   node connect-cli.js check              # log in with account #1, fetch the security token (login only, no changes)
 *   node connect-cli.js assign-did --tenant 2 --did 8455551234 [--commit]
 *   node connect-cli.js import-ext --tenant-path f3df739ac62197cd --csv ./ext.csv [--commit]
 */
const { loadConfig, ConnectSession, Pool } = require('./connect-lib');

function args(argv) {
  const a = { _: [], commit: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--commit') a.commit = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
    else a._.push(k);
  }
  return a;
}

(async () => {
  const a = args(process.argv);
  const cmd = a._[0];
  const cfg = loadConfig();

  if (cmd === 'pool') {
    console.log(`Base URL : ${cfg.baseUrl}`);
    console.log(`Accounts : ${cfg.accounts.length} loaded  ->  ${cfg.accounts.map(x => x.id).join(', ')}`);
    console.log(`Max simultaneous jobs = ${cfg.accounts.length}`);
    return;
  }

  if (cmd === 'check') {
    const s = new ConnectSession(cfg.baseUrl, cfg.accounts[0]);
    await s.login();
    const csrf = await s.ensureCsrf();
    console.log(`[${cfg.accounts[0].id}] login OK (sid set). security token fetched: ${csrf ? 'yes (' + csrf.length + ' chars)' : 'NO — token scrape needs tuning'}`);
    return;
  }

  if (cmd === 'assign-did') {
    if (!a.tenant || !a.did) throw new Error('need --tenant <id> --did <digits>');
    const s = await new ConnectSession(cfg.baseUrl, cfg.accounts[0]).login();
    const r = await s.assignDid({ did: a.did, tenantId: a.tenant, description: a.desc || '' }, { dryRun: !a.commit });
    console.log(JSON.stringify(r, null, 2));
    if (!a.commit) console.log('\nDRY RUN — nothing changed. Add --commit to actually assign.');
    return;
  }

  if (cmd === 'import-ext') {
    if (!a['tenant-path'] || !a.csv) throw new Error('need --tenant-path <hash> --csv <file>');
    const s = await new ConnectSession(cfg.baseUrl, cfg.accounts[0]).login();
    s.setTenant(a['tenant-path']);
    const r = await s.importExtensionsCsv(a.csv, { dryRun: !a.commit });
    console.log(JSON.stringify(r, null, 2));
    if (!a.commit) console.log('\nDRY RUN — nothing changed. Add --commit to actually import.');
    return;
  }

  console.log('commands: pool | check | assign-did | import-ext   (see file header)');
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
