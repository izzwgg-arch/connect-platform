use `ombutel`;

alter table `ombu_certificates`
 add column if not exists `sub_domains` text null default null after `hostname`;