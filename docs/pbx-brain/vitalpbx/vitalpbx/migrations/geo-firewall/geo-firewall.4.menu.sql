use `ombutel`;

delete from `ombu_menu` where `label` = 'menu.geo_firewall';

select `menu_id` into @firewall_menu from `ombu_menu` where `label` = 'menu.firewall' and module_id is null;

insert into ombu_menu (`label`, `parent_id`, `module_id`, `sort`)
select
  CONCAT('menu', '.', `name`),
  @firewall_menu,
  `module_id`,
  4
from `ombu_modules`
where `name` in ('geo_firewall');