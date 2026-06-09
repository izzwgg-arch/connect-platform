use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
('branding', 'no', 'yes', 'no', 'no');

set @module_id = last_insert_id();

insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       @module_id,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
where `role` = 'super_administrator';

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
  'menu.branding',
  `menu_id`,
  @module_id,
  30
from `ombu_menu`
where `label` = 'menu.admin' and `parent_id` is not null;