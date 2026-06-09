use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`)
values ('firewall_access_control', 'no', 'yes', 'no', 'no');

set @module_id = last_insert_id();

/* Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    'menu.firewall_access_control',
    `menu_id`,
    @module_id,
    2
from `ombu_menu`
where `label` = 'menu.firewall' and parent_id is not null;

/* Give the required privileges for super-admin users */
insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       m.`module_id`,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
         left join ombu_modules as m on (`m`.name in ('firewall_access_control'))
where `role` = 'super_administrator';

/* Update menu sort */
update `ombu_menu` set sort = 3 where label = 'menu.firewall_services' and parent_id is not null;
update `ombu_menu` set sort = 4 where label = 'menu.firewall_rules' and parent_id is not null;