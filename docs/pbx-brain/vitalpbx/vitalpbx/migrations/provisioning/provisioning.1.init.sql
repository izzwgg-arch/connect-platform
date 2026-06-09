use `ombutel`;

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.provisioning',
    `parent`.`menu_id`,
    null,
    10,
    'fas fa-phone-square-alt fa-fw'
from `ombu_menu` as `parent`
where `parent`.`label` = 'menu.pbx' and `parent`.`parent_id` is null;

set @parent_id = last_insert_id();

insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `portal`) values
('provisioning_connection_settings', 'no', 'yes', 'no'),
('provisioning_settings', 'no', 'yes', 'no'),
('provisioning_firmwares', 'no', 'yes', 'no'),
('provisioning_templates', 'no', 'no', 'no'),
('provisioning', 'no', 'no', 'no');

set @n = 0;
insert into `ombutel`.`ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    CONCAT('menu', '.', `name`),
    @parent_id,
    `module_id`,
    @n := @n + 1
from `ombu_modules`
where `name` in ('provisioning_connection_settings' ,'provisioning_settings', 'provisioning_firmwares', 'provisioning_templates', 'provisioning');

select `role_id` into @main_role from `ombu_roles` where `role` = 'super_administrator' limit 1;

insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select
    @main_role,
    `module_id`,
    'yes',
    'yes',
    'yes',
    'yes'
from `ombu_modules`
where `name` in ('provisioning_connection_settings' ,'provisioning_settings', 'provisioning_firmwares', 'provisioning_templates', 'provisioning');