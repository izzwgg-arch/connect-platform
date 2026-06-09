use `ombutel`;

alter table `ombu_trunks`
 add column `disable_hangup_audios` enum('yes', 'no') not null default 'no' after `continue_on_busy`;
