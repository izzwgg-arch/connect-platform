use `ombutel`;

update `ombu_menu` set icon = 'fa-solid fa-utility-pole-double' where label = 'menu.external' and parent_id is not null;
update `ombu_menu` set icon = 'fa-duotone fa-list-tree' where label = 'menu.class_of_service' and parent_id is not null;
update `ombu_menu` set icon = 'fa-solid fa-screen-users' where label = 'menu.callcenter' and parent_id is not null;
update `ombu_menu` set icon = 'fa-duotone fa-box-open-full' where label = 'menu.applications' and parent_id is not null;
update `ombu_menu` set icon = 'fa-duotone fa-hand-holding-box' where label = 'menu.incoming_calls' and parent_id is not null;
update `ombu_menu` set icon = 'fa-duotone fa-boxes-stacked' where label = 'menu.tools' and parent_id is not null;
update `ombu_menu` set icon = 'fa-regular fa-layer-plus' where label = 'menu.extras' and parent_id is not null;
update `ombu_menu` set icon = 'fa-solid fa-square-h' where label = 'menu.emergency_calls' and parent_id is not null;
update `ombu_menu` set icon = 'fa-solid fa-files' where label = 'menu.reports' and parent_id is null;
update `ombu_menu` set icon = 'fa-solid fa-gears' where label = 'menu.settings' and parent_id is null;
update `ombu_menu` set icon = 'fa-solid fa-block-brick-fire' where label = 'menu.firewall' and parent_id is not null;
update `ombu_menu` set icon = 'fa-solid fa-grid-2-plus' where label = 'menu.addons_market' and parent_id is not null;