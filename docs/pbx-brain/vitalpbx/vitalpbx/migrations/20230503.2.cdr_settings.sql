use `ombutel`;

insert into `ombu_modules` (`name`, `has_dialplan`, `admin`, `portal`) values
    ('cdr_settings', 'no', 'yes', 'no');

set @module_id = last_insert_id();

insert into `ombu_role_privileges` (`role_id`,`module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select `role_id`,
       @module_id,
       'yes',
       'yes',
       'yes',
       'yes'
from `ombu_roles`
where `role` = 'super_administrator';

insert into `ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
select
    'menu.cdr_settings',
    `menu_id`,
    @module_id,
    6
from `ombu_menu`
where `label` = 'menu.pbx_settings' and `icon` is not null;

/* Initial Values */
insert into ombu_settings (`module_id`, `name`, `value`) values
 (@module_id, 'batch', 'no'),
 (@module_id, 'size', 100),
 (@module_id, 'time', 300);

/* Add CDR driver */
insert into `ombu_asterisk_drivers` (`name`, driver) values
    ('cdr', 'cdr');