use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
  ('maintenance', 'no', 'yes', 'no', 'no');

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
    'menu.maintenance',
    `menu_id`,
    @module_id,
    10
  from `ombu_menu`
  where `label` = 'menu.system_settings' and `icon` is not null;

insert ignore into `ombu_settings` (`module_id`, `name`, `value`) values
  (@module_id, 'cdr_preservation', null),
  (@module_id, 'recordings_preservation', 180),
  (@module_id, 'recordings_clear_less_nseconds', 1),
  (@module_id, 'covert_recordings', 'no'),
  (@module_id, 'maintenance_cron', null),
  (@module_id, 'maintenance_running', 'no')
on duplicate key update `value` = if(`value` = "", values(`value`), `value`);