use `ombutel`;

create table if not exists `ombu_sms_providers` (
    `id` int unsigned not null auto_increment,
    `provider` varchar(255) not null,
    `auth_method` enum('api_key', 'basic_auth', 'sid', 'api_auth') not null default 'api_key',
    `format` enum('e164', '10-digit', '11-digit') not null default 'e164',
    unique (`provider`),
    primary key (`id`)
) character set utf8 collate utf8_unicode_ci;

create table if not exists `ombu_sms_connections` (
 `id` int unsigned not null auto_increment,
 `uuid` varchar(255) not null,
 `provider_id` int unsigned not null,
 `description` varchar(255) not null,
 `api_key` varchar(255) null default null,
 `auth_username` varchar(255) null default null,
 `auth_password` varchar(255) null default null,
 `tenant_id` int unsigned not null,
 primary key (`id`),
 unique (`uuid`),
 index (`description`),
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
 foreign key (`provider_id`) references `ombu_sms_providers` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table if not exists `ombu_sms_connection_numbers` (
 `id` int unsigned not null auto_increment,
 `connection_id` int unsigned not null,
 `phone_number` varchar(255) not null,
 `description` varchar(255) null default null,
 unique (`phone_number`),
 primary key (`id`),
 foreign key (`connection_id`) references `ombu_sms_connections` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table if not exists `ombu_sms_notifications` (
 `id` int unsigned not null auto_increment,
 `conn_number_id` int unsigned not null,
 `description` varchar(255) not null,
 `prefix` varchar(255) null default null,
 `recipient` varchar(255) null default null,
 `message` text not null,
 `destination_id` int unsigned null default null,
 `tenant_id` int unsigned not null,
 primary key (`id`),
 index (`description`),
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
 foreign key (`conn_number_id`) references `ombu_sms_connection_numbers` (`id`) on delete cascade,
 foreign key (`destination_id`) references `ombu_destinations` (`id`) on delete set null
) character set utf8 collate utf8_unicode_ci;

create table if not exists `ombu_sms_messages` (
    `id` int unsigned not null auto_increment,
    `connection_id` int unsigned not null,
    `sender` varchar(255) not null,
    `recipient` varchar(255) not null,
    `message` text null default null,
    `direction` enum('in', 'out') not null,
    `status` varchar(255) not null,
    `created_at` datetime not null default '0000-00-00 00:00:00',
    `uid` varchar(255) null default null,
    `errors` text null default null,
    `tenant_id` int unsigned not null,
    primary key (`id`),
    unique (`uid`),
    foreign key (`connection_id`) references `ombu_sms_connections` (`id`) on delete cascade,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table if not exists `ombu_tenant_sms_numbers` (
 `tenant_id` int unsigned not null,
 `conn_number_id` int unsigned not null,
 foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade,
 foreign key (`conn_number_id`) references `ombu_sms_connection_numbers` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;