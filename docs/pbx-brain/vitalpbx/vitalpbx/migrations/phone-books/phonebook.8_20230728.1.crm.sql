use `ombutel`;

alter table `ombu_phone_book_external_contacts`
 add column `crm_id` varchar(255) null default null after `phone_book_id`,
 add column `fax` varchar(255) null default null after `home_number`,
 add column `crm_type` varchar(255) null default null,
 add column `update_at` varchar(255) null default null;

alter table `ombu_phone_books`
 add column `crm` enum('yes', 'no') not null default 'no' after `prefix`,
 add column `read_only` enum('yes', 'no') not null default 'no' after `crm`;
