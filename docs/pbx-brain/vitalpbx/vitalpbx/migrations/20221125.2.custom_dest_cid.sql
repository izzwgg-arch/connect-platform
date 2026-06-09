use `ombutel`;

alter table ombu_custom_destinations
 add column `cid_name` varchar(255) null default null after `class_of_service_id`,
 add column `cid_number` varchar(255) null default null after `cid_name`;