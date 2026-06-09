use `ombutel`;

alter table `ai_assistants`
 add column if not exists `api_version` enum('v1', 'v2') not null default 'v1' after `notifications_email`,
 add column if not exists `temperature` float signed not null default 1 after `api_version`;