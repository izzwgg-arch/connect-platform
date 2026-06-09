select `menu_id` into @menu_id from `ombutel`.`ombu_menu` where `label` = 'menu.security';

update `ombutel`.`ombu_menu` set
  `parent_id` = @menu_id,
  `sort` = 4
where `label` = 'menu.vpn_server';