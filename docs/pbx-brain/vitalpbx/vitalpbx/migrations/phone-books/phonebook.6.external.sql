use `ombutel`;

alter table `ombu_phone_book_external_contacts`
 add column `contact_id` int unsigned not null auto_increment first,
 add primary key (`contact_id`),
 add column `mobile_number` varchar(255) null default null after `phone`,
 add column `home_number` varchar(255) null default null after `mobile_number`,
 modify column `phone` varchar(255) null default null;