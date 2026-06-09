use `ombutel`;

select `module_id` into @module from `ombu_modules` where `name` = 'vitalpbx';

insert into ombu_settings (`module_id`, `name`, `value`) values
(@module,'auto_generated_pwd_length',25);