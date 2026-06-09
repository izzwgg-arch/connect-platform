use `ombutel`;

select `menu_id` into @admin_menu from `ombu_menu` where `label` = 'menu.admin' and parent_id is null;

/* Organize network menu */
insert into `ombu_menu` (`label`, `parent_id`, `icon`, `sort`) values
  ('menu.network', @admin_menu, 'fas fa-network-wired', '4');

set @network_menu = last_insert_id();

update `ombu_menu` set `parent_id` = @network_menu, `sort` = 1
where `label` = 'menu.network_settings' and module_id is not null;

update `ombu_menu` set `label` = 'menu.dhcp_server', `parent_id` = @network_menu, `sort` = 2
where `label` = 'menu.dhcp_settings' and module_id is not null;