use `ombutel`;

create table if not exists `ai_api_keys` (
 `id` int unsigned not null auto_increment,
 `description` varchar(255) not null,
 `api_key` varchar(255) not null,
 `tenant_id` int unsigned not null,
 primary key (`id`),
 key (`description`),
 unique (`api_key`),
 foreign key `ai_api_keys_tenants_fk` (`tenant_id`) references ombu_tenants (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table if not exists `ai_assistants` (
 `id` int unsigned not null auto_increment,
 `api_key_id` int unsigned not null,
 `openai_id` varchar(255) null default null,
 `uuid` varchar(50) not null,
 `name` varchar(255) not null,
 `model` varchar(255) not null,
 `instructions` text not null,
 `max_interactions` int unsigned not null,
 `max_silence` int unsigned not null,
 `voice_profile_id` int unsigned not null,
 `welcome_msg_id` int unsigned null default null,
 `wait_msg_id` int unsigned null default null,
 `inaudible_msg_id` int unsigned null default null,
 `listening_msg_id` int unsigned null default null,
 `final_destination_id` int unsigned null default null,
 `internal_directory` varchar(255) null default null,
 `notifications_email` varchar(255) null default null,
 `tenant_id` int unsigned not null,
 primary key (`id`),
 unique (`openai_id`),
 unique (`uuid`),
 key (`name`),
 foreign key `ai_assistants_api_keys_fk` (`api_key_id`) references `ai_api_keys` (`id`) on delete restrict,
 foreign key `ai_assistants_voice_profiles_fk` (`voice_profile_id`) references `voice_profiles` (`id`) on delete restrict,
 foreign key `ai_assistants_tenants_fk` (`tenant_id`) references ombu_tenants (`tenant_id`) on delete cascade,
 foreign key `ai_assistants_recordings_01_fk` (`welcome_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
 foreign key `ai_assistants_recordings_02_fk` (`wait_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
 foreign key `ai_assistants_recordings_03_fk` (`inaudible_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
 foreign key `ai_assistants_recordings_04_fk` (`listening_msg_id`) references `ombu_recordings` (`recording_id`) on delete set null,
 foreign key `ai_assistants_destinations_fk` (`final_destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;