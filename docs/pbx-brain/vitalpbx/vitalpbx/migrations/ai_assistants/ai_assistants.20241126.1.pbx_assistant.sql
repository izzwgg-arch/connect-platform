use `ombutel`;

alter table `ai_assistants`
 modify column `voice_profile_id` int unsigned null default null,
 add column `pbx_assistant` enum('yes', 'no') not null default 'no' after `temperature`;