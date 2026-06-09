use `ombutel`;

select `module_id` into @module_id from `ombu_modules` where `name` = 'inbound_route';

insert into `ombu_destinations_category` (`module_id`) values (@module_id);