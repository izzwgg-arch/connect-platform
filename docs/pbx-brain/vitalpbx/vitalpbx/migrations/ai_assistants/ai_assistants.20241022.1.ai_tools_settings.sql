use `ombutel`;

alter table ai_tools
 add column if not exists `input_language` char(2) null default null after `ai_api_key_id`,
 add column if not exists `temperature` int(3) default 0 not null after `input_language`;