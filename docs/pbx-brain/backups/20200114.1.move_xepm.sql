use `ombutel`;

/* Move XEPM to PBX menu */
select `menu_id` into @admin_menu from `ombu_menu` where `label` = 'menu.pbx' and parent_id is null;

update `ombu_menu` set `parent_id` = @admin_menu, `sort` = 12 where `label` = 'menu.endpoint_manager' and `module_id` is null;