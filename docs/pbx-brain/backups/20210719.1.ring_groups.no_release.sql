use `ombutel`;

alter table `ombu_ring_groups`
 add column `no_release` enum('yes', 'no') not null default 'yes' after `skip_busy`;