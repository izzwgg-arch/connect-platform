use `ombutel`;

/* Remove the modules if they already exists */
delete from ombu_modules where `name` = 'ai_tools';

/* Add module */
insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`)
values ('ai_tools', 'no', 'yes', 'no','yes');

set @module_id = last_insert_id();

/* Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    'menu.ai_tools',
    `menu_id`,
    @module_id,
    3
from `ombu_menu`
where `label` = 'menu.ai_assistants' and `icon` is not null;

/* Roles and Privileges */
insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       @module_id,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
where `role` = 'super_administrator' limit 1;