use `ombutel`;

create table if not exists `ai_tools` (
    `id` int unsigned not null auto_increment,
    `ai_api_key_id` int unsigned not null,
    `voicemail_transcription` enum('yes', 'no') not null default 'no',
    `call_recordings_transcription` enum('yes', 'no') not null default 'no',
    `tenant_id` int unsigned not null,
    index (`id`, `tenant_id`),
    primary key (`id`),
    foreign key (`ai_api_key_id`) references `ai_api_keys` (`id`) on delete restrict,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) engine=innodb default charset=utf8;
