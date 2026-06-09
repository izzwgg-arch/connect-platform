/**
  Add tenant field for
 */
use `ombutel`;

alter table `ombu_app_keys`
 add column `tenant` int unsigned null default null after `key`;

update `ombu_app_keys` set `tenant` = `tenant_id` where `tenant` is null;