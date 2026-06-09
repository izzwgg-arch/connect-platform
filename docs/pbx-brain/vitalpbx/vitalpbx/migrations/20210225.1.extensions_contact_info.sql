use `ombutel`;

create table ombu_extensions_contact_info(
  `id` int unsigned not null auto_increment,
  `extension_id` int unsigned not null,
  `mobile_number` varchar(255) null default null,
  `home_number` varchar(255) null default null,
  `organization` varchar(255) null default null,
  `job_title` varchar(255) null default null,
  primary key (`id`),
  foreign key (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade
);