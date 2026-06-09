use `ombutel`;

select `menu_id` into @admin_tools_menu from `ombu_menu` where `label` = 'menu.admin_tools' and parent_id is not null;

update `ombu_menu` set `parent_id` = @admin_tools_menu, `sort` = 3
where `label` = 'menu.branding' and module_id is not null;