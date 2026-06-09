use `ombutel`;

alter table `ombu_emergency_locations`
 add column `external` enum('yes', 'no') not null default 'no' after `default`;