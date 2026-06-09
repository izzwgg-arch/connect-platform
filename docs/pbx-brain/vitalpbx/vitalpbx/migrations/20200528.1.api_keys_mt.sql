use `ombutel`;

select `tenant_id` into @tenant_id from `ombu_tenants` where `name` = 'vitalpbx';

alter table `ombu_app_keys`
  add column `tenant_id` int unsigned null default null,
  add foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade;