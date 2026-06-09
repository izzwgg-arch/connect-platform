use `ombutel`;

/* Remove the modules if they already exists */
delete from ombu_modules where `name` in ('sms_connections', 'sms_notifications', 'sms_messages');

insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `multi_tenant`) values
    ('sms_connections', 'no', 'yes', 'yes'),
    ('sms_notifications', 'yes', 'yes', 'yes'),
    ('sms_messages', 'no', 'yes', 'yes');


/* Configure role's permissions */
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
where `name` in ('sms_connections', 'sms_notifications', 'sms_messages');

/* Setup Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.sms',
    `menu_id`,
    null,
    16,
    'fa-regular fa-comment-dots'
from `ombu_menu`
where `label` = 'menu.pbx' and `parent_id` is null;

set @parent_menu_id = last_insert_id();
set @n = 0;

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    CONCAT('menu', '.', `name`),
    @parent_menu_id,
    `module_id`,
    @n := @n + 1
from `ombu_modules`
where `name` in ('sms_connections', 'sms_notifications', 'sms_messages');