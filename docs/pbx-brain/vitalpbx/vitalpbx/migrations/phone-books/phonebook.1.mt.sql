use `ombutel`;

select module_id into @module_id from `ombutel`.`ombu_modules` where `name` = 'phone_books';

update `ombu_modules` set `multi_tenant` = 'yes' where `module_id` = @module_id;

alter table `ombu_phone_books`
  add column `tenant_id` int unsigned null default null,
  add foreign key (`tenant_id`) references `ombu_tenants` (`tenant_id`) on delete cascade;

select `tenant_id` into @tenant_id from `ombu_tenants` where `name` = 'vitalpbx';

update `ombu_phone_books` set `tenant_id` = @tenant_id;