use `ombutel`;

/* Add module */
insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`)
values ('iax2_report', 'no', 'yes', 'no','yes');

set @module_id = last_insert_id();

/* Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    'menu.iax2_report',
    `menu_id`,
    @module_id,
    4
from `ombu_menu`
where `label` = 'menu.pbx_reports' and parent_id is not null;

/* Roles and Privileges */
insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       @module_id,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
where `superadmin` = 'yes';