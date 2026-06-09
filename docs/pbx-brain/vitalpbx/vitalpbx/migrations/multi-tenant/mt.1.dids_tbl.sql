use `ombutel`;

create table if not exists ombu_tenant_dids(
    `tenant_id` int unsigned not null,
    `did` varchar(255) not null,
    foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade
) character set utf8 collate utf8_unicode_ci;