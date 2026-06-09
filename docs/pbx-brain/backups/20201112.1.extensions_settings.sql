use `ombutel`;

alter table ombu_extensions
 add column  if not exists `dynamic_external_cid` enum('yes','no') not null default 'no' after `call_waiting`;

alter table `ombu_followme`
 add column  if not exists `internal_numbers_confirmation` enum ('yes', 'no') not null default 'no';