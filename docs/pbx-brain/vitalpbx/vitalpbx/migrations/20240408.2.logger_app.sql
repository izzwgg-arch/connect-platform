use `ombutel`;

insert into `ombu_modules` (`name`,`has_dialplan`, `admin`, `portal`) values
    ('event_logger', 'no', 'no', 'no');

set @module_id = last_insert_id();

insert into `ombu_role_privileges` (`role_id`, `module_id`, `allow_view`, `allow_add`, `allow_edit`, `allow_delete`)
select
    `role_id`,
    @module_id,
    'yes',
    'yes',
    'yes',
    'yes'
from `ombu_roles` where `role` = 'super_administrator';

insert into `ombutel`.`ombu_menu` (`label`, `parent_id`, `module_id`, `sort`, `icon`)
select
    'menu.system',
    `parent`.`menu_id`,
    null,
    5,
    'fa-solid fa-laptop-file'
from `ombutel`.`ombu_menu` as `parent`
where `parent`.`label` = 'menu.reports' and `parent`.`parent_id` is null;

set @parent_id = last_insert_id();

insert into `ombutel`.`ombu_menu` (`label`, `parent_id`, `module_id`, `sort`)
values ('menu.event_logger', @parent_id, @module_id, 1);