use `ombutel`;

/* Remove the modules if they already exists */
delete from ombu_modules where `name` in ('auth_destinations');

insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `multi_tenant`) values
 ('auth_destinations', 'yes', 'yes', 'yes');

set @module_id = last_insert_id();

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
where `name` in ('auth_destinations');

/* Setup Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    'menu.auth_destinations',
    `menu_id`,
    @module_id,
    10
from `ombu_menu`
where `label` = 'menu.incoming_calls' and `icon` is not null;