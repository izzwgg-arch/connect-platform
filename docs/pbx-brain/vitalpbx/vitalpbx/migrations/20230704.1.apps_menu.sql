use `ombutel`;

delete from ombu_menu where `label` = 'menu.apps' and parent_id is null and module_id is null;

insert into ombu_menu (`label`, `icon`, `sort`) values ('menu.apps', 'fa-light fa-layer-plus', 6);