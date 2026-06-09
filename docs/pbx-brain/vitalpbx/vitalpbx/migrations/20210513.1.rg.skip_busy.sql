use `ombutel`;

alter table `ombu_ring_groups`
 add column `skip_busy` enum('yes', 'no') not null default 'no' after `answerchannel`;