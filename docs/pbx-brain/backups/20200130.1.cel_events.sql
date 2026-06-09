use `asterisk`;

drop table if exists `cel`;

create table `cel` (
   `id` int(11) not null auto_increment,
   `eventtype` varchar(255) collate utf8_unicode_ci not null,
   `eventtime` datetime not null,
   `userdeftype` varchar(255) collate utf8_unicode_ci not null,
   `cid_name` varchar(255) collate utf8_unicode_ci not null,
   `cid_num` varchar(255) collate utf8_unicode_ci not null,
   `cid_ani` varchar(255) collate utf8_unicode_ci not null,
   `cid_rdnis` varchar(255) collate utf8_unicode_ci not null,
   `cid_dnid` varchar(255) collate utf8_unicode_ci not null,
   `exten` varchar(255) collate utf8_unicode_ci not null,
   `context` varchar(255) collate utf8_unicode_ci not null,
   `channame` varchar(255) collate utf8_unicode_ci not null,
   `appname` varchar(255) collate utf8_unicode_ci not null,
   `appdata` varchar(255) collate utf8_unicode_ci not null,
   `accountcode` varchar(255) collate utf8_unicode_ci not null,
   `peeraccount` varchar(255) collate utf8_unicode_ci not null,
   `uniqueid` varchar(255) collate utf8_unicode_ci not null,
   `linkedid` varchar(255) collate utf8_unicode_ci not null,
   `amaflags` int(11) not null,
   `userfield` varchar(255) collate utf8_unicode_ci not null,
   `peer` varchar(255) collate utf8_unicode_ci not null,
   `extra` varchar(255) collate utf8_unicode_ci not null,
   primary key (`id`),
   key `uniqueid` (`uniqueid`),
   key `linkedid` (`linkedid`)
) engine=innodb default charset=utf8 collate=utf8_unicode_ci;

grant select on `asterisk`.`cel` to `ombutel`@`localhost` identified by 'ombutel';