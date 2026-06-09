use `ombutel`;

/* Remove the modules if they already exists */
delete from ombu_modules where `name` in ('voice_connectors', 'voice_profiles');

/* add-on modules */
insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `multi_tenant`) values
 ('voice_connectors', 'no', 'yes', 'yes'),
 ('voice_profiles', 'no', 'yes', 'yes');

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
where `name` in ('voice_connectors', 'voice_profiles');

/* Setup Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.voice_hub',
    `menu_id`,
    null,
    5,
    'fa-sharp fa-solid fa-signal-stream'
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
where `name` in ('voice_connectors', 'voice_profiles');