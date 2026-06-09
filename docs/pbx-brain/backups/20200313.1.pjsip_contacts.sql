use `ombutel`;

alter table `ombu_pjsip_profiles`
 add column `remove_existing` enum('yes', 'no') not null default 'no';