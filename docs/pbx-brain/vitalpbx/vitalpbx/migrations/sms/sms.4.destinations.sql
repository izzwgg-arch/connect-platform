use `ombutel`;

select `module_id` into @module from `ombu_modules` where `name` = 'sms_notifications';

insert into `ombutel`.`ombu_destinations_category` (`module_id`) values
    (@module);