use `ombutel`;

create table `voice_providers` (
   `id` int unsigned not null auto_increment,
   `name` varchar(255) not null,
   primary key (`id`),
   unique (`name`)
) character set utf8 collate utf8_unicode_ci;

create table `voice_connections` (
   `id` int unsigned not null auto_increment,
   `provider_id` int unsigned not null,
   `description` varchar(255) not null,
   `tenant_id` int unsigned not null,
   primary key (`id`),
   key (`description`),
   foreign key (`provider_id`) references `voice_providers` (`id`) on delete cascade,
   foreign key `voice_connections_tenants_fk` (`tenant_id`) references ombu_tenants (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `voice_connection_parameters` (
    `connection_id` int unsigned not null,
    `param` varchar(255) not null,
    `value` varchar(255) not null,
    key (`param`),
    foreign key (`connection_id`) references `voice_connections` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `voice_profiles` (
    `id` int unsigned not null auto_increment,
    `connection_id` int unsigned not null,
    `description` varchar(255) not null,
    `tenant_id` int unsigned not null,
    primary key (`id`),
    key (`description`),
    foreign key (`connection_id`) references `voice_connections` (`id`) on delete cascade,
    foreign key `voice_profiles_tenants_fk` (`tenant_id`) references ombu_tenants (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

create table `voice_profile_parameters` (
   `voice_profile_id` int unsigned not null,
   `param` varchar(255) not null,
   `value` varchar(255) not null,
   key (`param`),
   foreign key (`voice_profile_id`) references `voice_profiles` (`id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;

