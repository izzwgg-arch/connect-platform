use `ombutel`;

/* Remove the modules if they already exists */
delete from ombu_modules where `name` in ('crm_integration');

insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `multi_tenant`) values
 ('crm_integration', 'yes', 'yes', 'yes');

/* Configure roles */
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
where `name` in ('crm_integration');

/* Configure menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.crm',
    `menu_id`,
    null,
    2,
    'fa-solid fa-people-group'
from `ombu_menu`
where `label` = 'menu.apps' and `parent_id` is null;

set @parent_menu_id = last_insert_id();
set @n = 0;

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    CONCAT('menu', '.', `name`),
    @parent_menu_id,
    `module_id`,
    @n := @n + 1
from `ombu_modules`
where `name` in ('crm_integration');