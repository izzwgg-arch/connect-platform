use `ombutel`;

select `module_id` into @module from `ombu_modules` where `name` = 'feature_code';

insert into ombu_settings (`module_id`, `name`, `value`) values
(@module,'atxfernoanswertimeout',15),
(@module,'atxferdropcall','no');