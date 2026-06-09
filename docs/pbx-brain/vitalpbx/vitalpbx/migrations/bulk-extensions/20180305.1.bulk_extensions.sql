use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`) values
  ('bulk_extensions', 'no', 'yes', 'no');

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
    'menu.bulk_extensions',
    `menu_id`,
    @module_id,
    6
  from `ombu_menu`
  where `label` = 'menu.extensions' and `module_id` is null;

-- Change the order of items in the sub-menu Extensions
update `ombu_menu` set `sort` = 7 where `label` = 'menu.extensions_status';
