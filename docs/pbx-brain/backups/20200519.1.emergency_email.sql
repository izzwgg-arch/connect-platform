use `ombutel`;

alter table `ombu_emergency_number_categories`
 add column `email_addresses` varchar(255) null default null after `description`;