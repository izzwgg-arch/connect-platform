use `ombutel`;

alter table `ombu_queues`
 add column if not exists `ring_unavailable` enum ('yes', 'no') not null default 'no' after `ringinuse`;