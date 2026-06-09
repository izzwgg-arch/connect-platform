use `ombutel`;

alter table `ombu_voicemail_broadcasts`
 add column `skip_instructions` enum('yes', 'no')  not null default 'no' after `password`;