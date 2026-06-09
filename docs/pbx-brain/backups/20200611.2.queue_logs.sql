use `asterisk`;

create table if not exists `queues_log` (
  `id` bigint(255) unsigned not null auto_increment,
  `time` varchar(255) not null default '',
  `callid` varchar(255) not null default '',
  `queuename` varchar(255) not null default '',
  `agent` varchar(255) not null default '',
  `event` varchar(255) not null default '',
  `data` varchar(255) default null,
  `data1` varchar(255) default null,
  `data2` varchar(255) default null,
  `data3` varchar(255) default null,
  `data4` varchar(255) default null,
  `data5` varchar(255) default null,
  `created` timestamp not null default current_timestamp(),
  primary key (`id`),
  key `callid` (`callid`),
  key `queuename` (`queuename`),
  key `event` (`event`),
  key `agent` (`agent`)
) engine=innodb default charset=utf8;
