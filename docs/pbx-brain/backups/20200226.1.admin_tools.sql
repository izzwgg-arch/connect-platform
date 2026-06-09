use `ombutel`;

select `menu_id` into @admin_menu from `ombu_menu` where `label` = 'menu.admin' and parent_id is null;

/* Organize tools menu */
insert into `ombu_menu` (`label`, `parent_id`, `icon`, `sort`) values
('menu.admin_tools', @admin_menu, 'fas fa-toolbox', '6');

set @tools_menu = last_insert_id();

update `ombu_menu` set `parent_id` = @tools_menu, `sort` = 1
where `label` = 'menu.backup_and_restore' and module_id is not null;