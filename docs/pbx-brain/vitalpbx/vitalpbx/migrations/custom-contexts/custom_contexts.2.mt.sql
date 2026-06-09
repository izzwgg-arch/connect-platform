use `ombutel`;

select `tenant_id` into @tenant_id from `ombu_tenants` where `name` = 'vitalpbx';

alter table `ombu_custom_contexts`
    add column `tenant_id` int unsigned null default null,
    add foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade;

update `ombu_custom_contexts` set `tenant_id` = @tenant_id;

update ombu_modules set `multi_tenant` = 'yes' where `name` = 'custom_contexts';