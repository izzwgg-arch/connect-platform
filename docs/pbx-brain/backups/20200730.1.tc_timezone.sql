use `ombutel`;

alter table `ombu_time_conditions`
 add column `timezone` varchar(255) not null default 'system' after `blf_inverted`;