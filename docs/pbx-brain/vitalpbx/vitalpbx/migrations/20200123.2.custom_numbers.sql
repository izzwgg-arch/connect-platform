use `ombutel`;

insert into ombu_modules (`name`, `has_dialplan`, `admin`, `portal`, `multi_tenant`) values
('custom_numbers', 'no', 'yes', 'no', 'no');

set @custom_numbers_module = last_insert_id();

insert into `ombu_destinations_category` (`module_id`) values (@custom_numbers_module);

alter table `ombu_destinations`
 modify column `index` varchar(255) not null;