create table `ombutel`.`ombu_ivr_stats` (
  `ivr_stat_id` int unsigned not null auto_increment,
  `ivr_id` int unsigned not null,
  `ivr_option` varchar(255) null default null,
  `unique_id` varchar(255) not null,
  primary key (`ivr_stat_id`),
  foreign key (`ivr_id`) references `ombutel`.`ombu_ivrs` (`ivr_id`) on delete cascade
);