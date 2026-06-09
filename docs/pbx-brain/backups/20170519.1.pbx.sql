create table `astboard`.`pbx`(
  `pbx_id` int unsigned not null auto_increment,
  `description` varchar(255) not null,
  `pbx` enum('ombutel','free_pbx') not null default 'ombutel',
  `db_pass` varchar(255) null default null,
  `connected` enum('yes', 'no') not null default 'no',
  primary key (`pbx_id`)
) engine=InnoDB character set utf8;