use `ombutel`;

alter table ombu_maintenance
    drop column `running`,
    add column `voicemail_preservation` int unsigned null default null after `recordings_preservation`,
    add column `conversion_quality` int unsigned null default null after `convert_recordings`,
    add column `default` enum('yes','no') not null default 'no' after `enabled`;

update `ombu_maintenance` set `default` = 'yes', `voicemail_preservation` = 60, `conversion_quality` = 16 where `id` = 1;

update `ombu_maintenance` set `maintenance_cron` = null where `id` != 1;