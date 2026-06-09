use `ombutel`;

alter table `ombu_queues_callback`
  add column if not exists `thank_you_prompt_id` int unsigned null default null after `invalid_message_id`,
  add foreign key (`thank_you_prompt_id`) references `ombu_recordings` (`recording_id`) on delete set null;