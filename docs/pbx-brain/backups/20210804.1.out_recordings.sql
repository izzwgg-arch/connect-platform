use `ombutel`;

alter table `ombu_outbound_routes`
 add column `record` enum('yes', 'no') not null default 'no' after `overwrite_cid`;

alter table `ombu_trunks`
 add column `record` enum('yes', 'no') not null default 'no' after `disable_hangup_audios`;