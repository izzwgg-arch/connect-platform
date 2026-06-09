use `ombutel`;

alter table ombu_maintenance
    add column if not exists `sms_preservation` int unsigned null default null after `voicemail_preservation`;