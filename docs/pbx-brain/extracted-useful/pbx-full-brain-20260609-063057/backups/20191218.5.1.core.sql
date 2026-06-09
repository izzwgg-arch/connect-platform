use `ombutel`;

update ombu_modules set `name` = 'vitalpbx' where `name` = 'ombutel';

update ombu_menu set `module_id` = null where `label` = 'menu.pbx_reports';