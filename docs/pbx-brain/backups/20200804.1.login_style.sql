use `ombutel`;

select `module_id` into @module from `ombu_modules` where `name` = 'vitalpbx';

insert into ombu_settings (`module_id`, `name`, `value`) values
 (@module,'login_bg',null),
 (@module,'login_fc','#769c7b'),
 (@module,'login_frm_bg','#769c7b'),
 (@module,'login_btn','#71a97b'),
 (@module,'login_addons_menu','#647f67');
