use `ombutel`;

select `module_id` into @module from `ombu_modules` where `name` = 'vitalpbx';

insert into ombu_settings (`module_id`, `name`, `value`) values
    (@module,'base_color','#529367'),
    (@module,'login_bg','#529367'),
    (@module,'login_fc','#ffffff'),
    (@module,'login_frm_bg','rgba(68,72,71,0.42)'),
    (@module,'disable_login_bg','no'),
    (@module,'login_btn','rgba(32,44,44,0.49)'),
    (@module,'login_addons_menu','rgba(36,54,54,0.34)'),
    (@module,'branding_enabled','no'),
    (@module,'gui_top_navbar_bg','#293540'),
    (@module,'gui_top_navbar_fc','#ffffff'),
    (@module,'gui_menu_bg_color_1','#293540'),
    (@module,'gui_menu_bg_color_2','#293846'),
    (@module,'gui_menu_fc','#ffffff'),
    (@module,'gui_menu_fc_active','#7bcb95')
on duplicate key update `value` = values(`value`);