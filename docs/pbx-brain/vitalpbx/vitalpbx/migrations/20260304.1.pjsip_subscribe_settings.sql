use `ombutel`;

alter table ombu_pjsip_profiles
 add column if not exists `sub_min_expiry` int unsigned not null default 300,
 add column if not exists `mwi_subscribe_replaces_unsolicited` enum('yes','no') not null default 'yes',
 add column if not exists `timers` enum('yes','no') not null default 'yes';