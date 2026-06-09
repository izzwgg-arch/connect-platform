use ombutel;

create table if not exists `ombu_dialrules_internal_patterns` (
  `dialrule_id` int unsigned not null,
  `pattern` varchar(255) not null,
  `recording_id` int unsigned null default null,
  `sort` int unsigned not null,
  foreign key (`dialrule_id`) references `ombu_dialrules` (`dialrule_id`) on delete cascade,
  foreign key (`recording_id`) references `ombu_recordings` (`recording_id`) on delete set null
) engine=innodb default charset=utf8;