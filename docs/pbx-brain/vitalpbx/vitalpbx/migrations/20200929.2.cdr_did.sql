use `asterisk`;

alter table `cdr`
 add column if not exists `did` varchar(255) null default null after `clid`;