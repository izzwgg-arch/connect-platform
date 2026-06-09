use `ombutel`;

alter table ombu_recordings
 add column if not exists `voice_profile_id` int unsigned null default null after `auth_pin`;