use `ombutel`;

/* Move Weak Passwords to PBX menu */
select `menu_id` into @tools_menu from `ombu_menu` where `label` = 'menu.tools' and module_id is null;

update `ombu_menu` set `parent_id` = @tools_menu, `sort` = 6 where `label` = 'menu.weak_passwords' and `module_id` is not null;