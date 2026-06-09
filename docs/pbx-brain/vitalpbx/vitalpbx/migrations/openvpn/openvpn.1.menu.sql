use `ombutel`;

delete from `ombu_menu` where `label` in ('menu.vpn_client', 'menu.vpn_server');

select `menu_id` into @net_menu from `ombu_menu` where `label` = 'menu.network' and module_id is null;

set @n = 2;
insert into ombu_menu (`label`, `parent_id`, `module_id`, `sort`)
select
  CONCAT('menu', '.', `name`),
  @net_menu,
  `module_id`,
  @n := @n + 1
from `ombu_modules`
where `name` in ('vpn_server', 'vpn_client');