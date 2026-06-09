use `ombutel`;

alter table `ombu_queues`
 add column `alertinfo` varchar(255) null default null after `autopause`,
 add column `answerchannel` enum('yes','no') not null default 'yes' after `retry`;