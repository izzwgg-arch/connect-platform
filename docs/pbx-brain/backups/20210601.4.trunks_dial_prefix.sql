use `ombutel`;

alter table ombu_trunks
 add column `dial_prefix` varchar(255) null default null after `trunk_cid`;