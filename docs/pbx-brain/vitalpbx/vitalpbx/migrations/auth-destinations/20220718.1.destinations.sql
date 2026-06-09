use `ombutel`;

select `module_id` into @module_id from `ombu_modules` where `name` = 'auth_destinations';

insert into `ombu_destinations_category` (`module_id`) values (@module_id);