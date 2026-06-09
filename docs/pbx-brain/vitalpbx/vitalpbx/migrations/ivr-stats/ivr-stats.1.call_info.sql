use `ombutel`;

alter table `ombu_ivr_stats`
 add column `caller` varchar(255) null default null after `ivr_option`,
 add column `callee` varchar(255) null default null after `caller`;