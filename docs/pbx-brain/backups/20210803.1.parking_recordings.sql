use `ombutel`;

alter table `ombu_parking_lots`
 add column `record` enum('yes', 'no') not null default 'no' after `announce_space_number`;