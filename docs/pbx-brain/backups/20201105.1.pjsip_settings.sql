use `ombutel`;

/* Copy some SIP Settings*/
select `module_id` into @sip_settings_module from `ombu_modules` where `name` = 'sip_settings';

insert into `ombu_pjsip_settings` (`param`, `value`)
select
    `name`,
    `value`
from `ombu_settings` where `name` = 'language' and module_id = @sip_settings_module;

/* Transport Settings */
insert into `ombu_pjsip_settings` (`param`, `value`) values
('allow_reload', 'yes');