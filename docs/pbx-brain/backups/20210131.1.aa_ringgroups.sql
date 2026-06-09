use `ombutel`;

alter table `ombu_ring_groups`
    add column `answerchannel` enum('yes','no') not null default 'yes' after `allow_diversions`;