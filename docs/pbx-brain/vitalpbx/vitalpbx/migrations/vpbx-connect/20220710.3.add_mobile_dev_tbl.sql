use `ombutel`;

create table `ombu_mobile_devices` (
 `id` int unsigned not null auto_increment,
 `device_id` int unsigned not null,
 `username` varchar(255),
 `password` varchar(255),
 `enable` enum('yes', 'no') not null default 'yes',
 `cloud_id` int unsigned null default null,
 `tenant_id` int unsigned not null,
 primary key (`id`),
 foreign key (`device_id`) references `ombu_devices` (`device_id`) on delete cascade,
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
 index (`username`),
 index (`password`)
) character set utf8 collate utf8_unicode_ci;