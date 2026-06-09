use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`)
  values ('cel_events', 'no', 'yes', 'no','no');

set @module_id = last_insert_id();

/* Initial Module Settings */
insert ignore into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`) values
(@module_id, 'enable', 'no'),
(@module_id, 'apps', 'dial,park,queue,confbridge,voicemail,originate,page,voicemailmain,transfer,blindtransfer,attendedtransfer'),
(@module_id, 'events', 'APP_START,CHAN_START,CHAN_END,ANSWER,HANGUP,BRIDGE_ENTER,BRIDGE_EXIT,BLINDTRANSFER,ATTENDEDTRANSFER,PICKUP,FORWARD,USER_DEFINED'),
(@module_id, 'dateformat', '%F %T')
on duplicate key update `value` = if(`value` = '', values(`value`), `value`);

/* Menu */
insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
  'menu.cel_events',
  `menu_id`,
  @module_id,
  6
from `ombu_menu`
where `label` = 'menu.pbx_settings' and parent_id is not null;

/* Roles and Privileges */
insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       @module_id,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
where `superadmin` = 'yes';

