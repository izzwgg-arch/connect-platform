create database if not exists `asterisk`;

create table `asterisk`.`cdr` (
	`cdr_id` int(10) unsigned not null auto_increment,
	`calldate` datetime not null default '0000-00-00 00:00:00',
	`clid` varchar(80) collate utf8_unicode_ci not null default '',
	`source` varchar(80) collate utf8_unicode_ci not null default '',
	`src` varchar(80) collate utf8_unicode_ci not null default '',
	`dst` varchar(80) collate utf8_unicode_ci not null default '',
	`destination` varchar(80) collate utf8_unicode_ci not null default '',
	`dcontext` varchar(80) collate utf8_unicode_ci not null default '',
	`channel` varchar(80) collate utf8_unicode_ci not null default '',
	`dstchannel` varchar(80) collate utf8_unicode_ci not null default '',
	`lastapp` varchar(80) collate utf8_unicode_ci not null default '',
	`lastdata` varchar(80) collate utf8_unicode_ci not null default '',
	`duration` int(11) not null default '0',
	`billsec` int(11) not null default '0',
	`disposition` varchar(45) collate utf8_unicode_ci not null default '',
	`amaflags` int(11) not null default '0',
	`accountcode` varchar(255) collate utf8_unicode_ci not null default '',
	`auth_code` varchar(255) collate utf8_unicode_ci default null,
	`customer_code` varchar(255) collate utf8_unicode_ci default null,
	`pin_code` varchar(255) collate utf8_unicode_ci default null,
	`uniqueid` varchar(32) collate utf8_unicode_ci not null default '',
	`linkedid` varchar(32) collate utf8_unicode_ci not null default '',
	`sequence` varchar(32) collate utf8_unicode_ci not null default '',
	`peeraccount` varchar(32) collate utf8_unicode_ci not null default '',
	`calltype` enum('1','2','3','4') collate utf8_unicode_ci not null default '1' comment 'VitalPBX\'s call type (1-local, 2-incoming, 3-outgoing)',
	`recfile` varchar(255) collate utf8_unicode_ci not null default '',
	`tenant` varchar(80) collate utf8_unicode_ci not null default '',
	`trunk` int(10) unsigned default null,
	primary key (`cdr_id`),
	key `tenant` (`tenant`,`calldate`),
	key `clid` (`clid`),
	key `src` (`src`),
	key `dst` (`dst`),
	key `accountcode` (`accountcode`),
	key `disposition` (`disposition`),
	key `billsec` (`billsec`),
	key `duration` (`duration`)
) character set utf8 collate utf8_unicode_ci;

grant all on `asterisk`.* to `asterisk`@`localhost` identified by 'asterisk';
grant select on `asterisk`.`cdr` to `ombutel`@`localhost` identified by 'ombutel';