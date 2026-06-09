use `ombutel`;

alter table `ombu_sms_connections`
 add column `events_url` text null default null after `space_url`;