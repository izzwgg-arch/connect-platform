use `ombutel`;

alter table ombu_queues
 add column `force_longest_waiting_caller` enum('yes', 'no') not null default 'no' after answerchannel,
 add column `force_moh` enum('yes', 'no') not null default 'no' after `force_longest_waiting_caller`;