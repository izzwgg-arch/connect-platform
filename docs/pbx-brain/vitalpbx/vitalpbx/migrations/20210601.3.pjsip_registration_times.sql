use `ombutel`;

alter table `ombu_pjsip_profiles`
 add column `default_expiration` int unsigned not null default 3600,
 add column `maximum_expiration` int unsigned not null default 7200,
 add column `minimum_expiration` int unsigned not null default 600;