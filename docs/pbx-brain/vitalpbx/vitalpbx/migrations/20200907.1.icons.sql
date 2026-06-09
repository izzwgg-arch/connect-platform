use ombutel;

update `ombu_menu` set icon = 'fas fa-phone-rotary' where label = 'menu.pbx' and parent_id is null;
update `ombu_menu` set icon = 'fas fa-phone-office' where label = 'menu.extensions' and parent_id is not null;
update `ombu_menu` set icon = 'fas fa-layer-plus' where label = 'menu.addons_market' and parent_id is not null;