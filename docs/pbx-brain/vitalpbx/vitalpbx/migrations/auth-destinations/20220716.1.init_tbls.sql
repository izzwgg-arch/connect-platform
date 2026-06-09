use ombutel;

create table `ombu_auth_destinations_groups` (
 `id` int unsigned not null auto_increment,
 `description` varchar(255) not null,
 `recording_id` int unsigned null default null,
 `match_destination` int unsigned null default  null,
 `unmatch_destination` int unsigned null default null,
 `tenant_id` int unsigned not null,
 primary key (`id`),
 foreign key (`recording_id`) references ombu_recordings (`recording_id`) on delete set null,
 foreign key (`match_destination`) references ombu_destinations (`id`) on delete set null,
 foreign key (`unmatch_destination`) references ombu_destinations (`id`) on delete set null,
 foreign key (`tenant_id`) references ombu_tenants (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `ombu_auth_destinations_groups_codes` (
    `auth_destination_group_id` int unsigned not null,
    `auth_code` varchar(255) not null,
    `cid_name` varchar(255) null default null,
    unique (`auth_destination_group_id`, `auth_code`),
    foreign key (`auth_destination_group_id`) references  ombu_auth_destinations_groups (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;