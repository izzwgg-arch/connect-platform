use `ombutel`;

alter table `ombu_ivrs`
 add column `asr_enabled` enum('yes', 'no') not null default 'no' after `generate_stats`;

alter table `ombu_ivr_entries`
 add column `asr_command` varchar(255) null default null after `destination_id`;