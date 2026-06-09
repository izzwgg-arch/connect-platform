use `ombutel`;

/* Add new firewall modules */
insert into ombu_modules (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
('firewall_settings', 'no', 'yes', 'no', 'no'),
('firewall_services', 'no', 'yes', 'no', 'no'),
('firewall_rules', 'no', 'yes', 'no', 'no');

/* update Security menu */
update `ombu_menu` set `label` = 'menu.firewall' where `label` = 'menu.security' and module_id is null;

select `menu_id` into @firewall_menu from `ombu_menu` where `label` = 'menu.firewall' and module_id is null;

set @n = 0;
insert into ombu_menu (`label`, `parent_id`, `module_id`, `sort`)
select
  CONCAT('menu', '.', `name`),
  @firewall_menu,
  `module_id`,
  @n := @n + 1
from `ombu_modules`
where `name` in ('firewall_settings', 'firewall_services', 'firewall_rules');

/* Set role permissions */
select `role_id` into @main_role from `ombu_roles` where `superadmin` = 'yes' limit 1;

insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select
  @main_role,
  `module_id`,
  'yes',
  'yes',
  'yes',
  'yes'
from `ombu_modules`
where `name` in ('firewall_settings', 'firewall_services', 'firewall_rules');

delete from ombu_menu where `label` in ('menu.firewall', 'menu.intrusion_detection') and `module_id`  is not null;
