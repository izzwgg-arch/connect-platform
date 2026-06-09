use `ombutel`;

delete from `ombu_menu` where `label` like 'menu.fop2%';

delete from `ombu_modules` where `name` like 'fop2%';

delete from `ombu_firewall_services` where `port` = '4445';