use `ombutel`;

alter table `ombu_recordings`
 add column `feature_code` varchar(255) null default null after `duration`,
 add column `auth_pin` varchar(255) null default null after `feature_code`;