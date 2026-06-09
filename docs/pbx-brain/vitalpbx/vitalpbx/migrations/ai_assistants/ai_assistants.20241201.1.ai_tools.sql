use `ombutel`;

alter table ai_tools
 add column `pbx_assistant` enum('yes', 'no') not null default 'no' after `temperature`,
 add column `ai_assistant_id` int unsigned null default null after `pbx_assistant`,
 add foreign key (`ai_assistant_id`) references `ai_assistants` (`id`) on delete set null;