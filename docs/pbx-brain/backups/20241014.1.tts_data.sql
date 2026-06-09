use `ombutel`;

alter table `ombu_recordings`
 add column `tts_text` text null default null after `voice_profile_id`;