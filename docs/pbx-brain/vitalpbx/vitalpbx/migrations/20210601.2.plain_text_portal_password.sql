use `ombutel`;

alter table `ombu_extensions`
 add column `portal_password` varchar(255) null default null after `features_password`;