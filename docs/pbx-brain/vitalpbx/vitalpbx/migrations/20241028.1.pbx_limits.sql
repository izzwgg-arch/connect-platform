use `ombutel`;

select `module_id` into @module_id from `ombutel`.`ombu_modules` where `name` = 'vitalpbx';

insert ignore into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`) values
    (@module_id, 'maximum_extensions', 5000),
    (@module_id, 'maximum_tenants', 50),
    (@module_id, 'maximum_queue_members', 10),
    (@module_id, 'enable_global_limits', 'yes')
on duplicate key update `value` = if(`value` = '', values(`value`), `value`);