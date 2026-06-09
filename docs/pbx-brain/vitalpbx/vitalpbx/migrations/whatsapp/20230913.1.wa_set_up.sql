use `ombutel`;

/* Remove the modules if they already exists */
delete from ombu_modules where `name` in ('whatsapp_connector', 'whatsapp_messages');

/* add-on modules */
insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `multi_tenant`) values
 ('whatsapp_connector', 'no', 'yes', 'yes'),
 ('whatsapp_messages', 'no', 'yes', 'yes');

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
where `name` in ('whatsapp_connector', 'whatsapp_messages');

/* Setup Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.whatsapp',
    `menu_id`,
    null,
    6,
    'fa-brands fa-whatsapp'
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
where `name` in ('whatsapp_connector', 'whatsapp_messages');