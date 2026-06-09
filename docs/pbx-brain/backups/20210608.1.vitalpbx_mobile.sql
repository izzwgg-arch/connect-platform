use `ombutel`;

update ombu_firewall_services set `port` = '3500-3501' where `name` = 'VPBX API';

/* Mark firewall module for reload */
select `module_id` into @module from `ombu_modules` where `name` = 'firewall';

insert ignore into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`) values
(@module, 'reload', 'yes')
on duplicate key update `value` = if(`value` = 'no', values(`value`), `value`);