use `ombutel`;

update ombu_menu set
  `icon` = 'fas fa-sliders-h' where `label` = 'menu.technology_settings';

update `ombu_menu` set `sort` = 1 where `label` = 'menu.pjsip_settings' and module_id is not null;
update `ombu_menu` set `sort` = 2 where `label` = 'menu.sip_settings' and module_id is not null;
update `ombu_menu` set `sort` = 3 where `label` = 'menu.iax_settings' and module_id is not null;
update `ombu_menu` set `sort` = 4 where `label` = 'menu.telephony_settings' and module_id is not null;
update `ombu_menu` set `sort` = 5 where `label` = 'menu.profiles' and module_id is not null;
update `ombu_menu` set `sort` = 6 where `label` = 'menu.dial_profiles' and module_id is not null;