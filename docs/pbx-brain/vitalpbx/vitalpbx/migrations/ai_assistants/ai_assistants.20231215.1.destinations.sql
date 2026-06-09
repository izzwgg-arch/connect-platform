use `ombutel`;

select `module_id` into @module from `ombu_modules` where `name` = 'ai_assistants';

insert into `ombutel`.`ombu_destinations_category` (`module_id`) values
    (@module);