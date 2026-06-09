use `ombutel`;

alter table `ombu_music_groups`
 add column `type` enum('files', 'custom') not null default 'files' after `order`,
 add column `application` text null default null after type,
 add column `streaming_url` text null default null after `application`,
 add column `streaming_format` text null default null after `streaming_url`;