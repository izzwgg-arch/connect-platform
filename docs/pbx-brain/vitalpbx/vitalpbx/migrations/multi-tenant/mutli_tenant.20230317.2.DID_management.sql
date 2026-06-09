use `ombutel`;

delete from ombu_modules where `name` in ('did_management');

insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `multi_tenant`) values
 ('did_management', 'no', 'yes', 'no');

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
where `name` in ('did_management');

/* Setup Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.did_management',
    `menu_id`,
    @module_id,
    2,
    null
from `ombu_menu`
where `label` = 'menu.multi_tenant' and `parent_id` is not null;