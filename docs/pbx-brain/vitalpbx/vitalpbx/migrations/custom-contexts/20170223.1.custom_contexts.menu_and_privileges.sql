use `ombutel`;

insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `portal`) values
  ('custom_contexts', 'yes', 'no', 'no');

set @module_id = last_insert_id();

insert into `ombutel`.`ombu_role_privileges` (`role_id`, `module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
  select
    `role_id`,
    @module_id,
    'yes',
    'yes',
    'yes',
    'yes'
  from `ombutel`.`ombu_roles` where `role` = 'super_administrator';

insert into `ombutel`.`ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
    select
      'menu.custom_contexts',
      `parent`.`menu_id`,
      @module_id,
      3
    from `ombutel`.`ombu_menu` as `parent`
    where `parent`.`label` = 'menu.applications' and `parent`.module_id is null;