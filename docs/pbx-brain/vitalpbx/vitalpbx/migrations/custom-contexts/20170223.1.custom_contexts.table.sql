create table `ombutel`.`ombu_custom_contexts`(
  `cc_id` int unsigned not null auto_increment,
  `description` varchar(255) not null,
  `context` varchar(255) not null,
  `extension` varchar(255) null default 's',
  `priority` varchar(255)  null default '1',
  `mod_dest` varchar(255) not null,
  `dest` varchar(255) not null,
  primary key(`cc_id`)
);