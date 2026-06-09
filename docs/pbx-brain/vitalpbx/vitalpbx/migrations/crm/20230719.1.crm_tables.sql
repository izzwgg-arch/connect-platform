use `ombutel`;

create table if not exists crm_vendors (
    `id` int unsigned not null auto_increment,
    `uuid` varchar(36) not null,
    `name` varchar(255) not null,
    `oauth` enum('yes', 'no'),
    unique (`name`),
    unique (`uuid`),
    primary key (`id`)
) character set utf8 collate utf8_unicode_ci;

create table if not exists  `crm_integrations`(
    `id` int unsigned not null auto_increment,
    `crm_vendor_id` int unsigned not null,
    `tenant_id` int unsigned not null,
    `phone_book_id` int unsigned null default null,
    `synchronize_contacts_from` varchar(255) null default null,
    `create_new_contacts_from` varchar(255) null default null,
    `new_contacts_type` varchar(255) null default null,
    `synchronize_contacts_automatically` enum('yes', 'no') not null default 'no',
    `create_contacts_automatically` enum('yes', 'no') not null default 'no',
    `log_calls` enum('yes', 'no') not null default 'no',
    `attributes` JSON null default null,
    `enabled` enum('yes', 'no') not null default 'yes',
    primary key (`id`),
    foreign key `crm_vendors_integrations_fk` (`crm_vendor_id`) references `crm_vendors` (`id`) on delete cascade,
    foreign key `crm_vendors_tenants_fk` (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table if not exists `crm_users`(
    `id` int unsigned not null auto_increment,
    `extension_id` int unsigned null default null,
    `crm_integration_id` int unsigned not null,
    `crm_id` varchar(255) not null,
    `name` varchar(255) not null,
    `email` varchar(255) null default null,
    unique (`crm_id`),
    primary key (`id`),
    foreign key `crm_users_extensions_fk` (`extension_id`) references `ombu_extensions` (`extension_id`) on delete cascade,
    foreign key `crm_users_integration_fk` (`crm_integration_id`) references `crm_integrations` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table if not exists `crm_pending_auths`(
    `id` int unsigned not null auto_increment,
    `crm_vendor_id` int unsigned not null,
    `tenant_id` int unsigned not null,
    `attributes` JSON null default null,
    primary key (`id`),
    foreign key `crm_vendors_pending_auths_fk` (`crm_vendor_id`) references `crm_vendors` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;