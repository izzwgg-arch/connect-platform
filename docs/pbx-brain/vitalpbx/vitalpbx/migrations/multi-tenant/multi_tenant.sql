use `ombutel`;

select `module_id` into @tenants_module from `ombu_modules` where `name` = 'tenants';

insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
  select `role_id`,
    @tenants_module,
    'yes',
    'yes',
    'yes',
    'yes'
  from `ombu_roles`
  where `role` = 'super_administrator';

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
  select
    'menu.tenants',
    `menu_id`,
    @tenants_module,
    10
  from `ombu_menu`
  where `label` = 'menu.admin' and `parent_id` is not null;

select `tenant_id` into @tenant_id from `ombu_tenants` where `name` = 'vitalpbx';

insert into `ombu_roles` (`role`, `description`, `default`, `tenant_id`) values
  ('tenant_admin', 'Tenant Administrator', 'yes', @tenant_id);

set @role_id = last_insert_id();

insert into `ombu_role_permissions` (`role_id`, `permission`, `allowed`) values
  (@role_id, 'change_language', 'yes'),
  (@role_id, 'get_updates', 'no'),
  (@role_id, 'update_profile', 'yes');

insert into `ombu_role_privileges` (`role_id`, `module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
  select
    @role_id,
    `module_id`,
    'yes',
    'yes',
    'yes',
    'yes'
  from `ombu_modules`
  where `multi_tenant` = 'yes' or `name` in  ('core', 'search', 'user_profile');


