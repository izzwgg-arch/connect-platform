/* Delete duplicated destinations category*/
use ombutel;

select `module_id` into @queues_callback_module from `ombu_modules` where `name` = 'queues_callback';

delete from ombu_destinations_category where `module_id` = @queues_callback_module;

insert into `ombutel`.`ombu_destinations_category` (`module_id`) values
(@queues_callback_module);