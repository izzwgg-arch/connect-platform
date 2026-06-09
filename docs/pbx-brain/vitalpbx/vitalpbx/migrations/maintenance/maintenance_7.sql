use `ombutel`;

alter table ombu_maintenance
    add column if not exists `logger_preservation` int unsigned null default null after `sms_preservation`;