use `ombutel`;

select `menu_id` into @settings_menu from `ombu_menu` where `label` = 'menu.settings' and parent_id is null;

/* Add voice prompts menu */
insert into `ombu_menu` (`label`, `parent_id`, `icon`, `sort`) values
('menu.voice_prompts', @settings_menu, 'fas fa-volume-up', 4);

set @voice_prompts_menu = last_insert_id();

update `ombu_menu` set `parent_id` = @voice_prompts_menu, `sort` = 1
where `label` = 'menu.asterisk_sounds' and module_id is not null;

update `ombu_menu` set `parent_id` = @voice_prompts_menu, `sort` = 2
where `label` = 'menu.music_on_hold' and module_id is not null;

update `ombu_menu` set `parent_id` = @voice_prompts_menu, `sort` = 3
where `label` = 'menu.recordings_management' and module_id is not null;