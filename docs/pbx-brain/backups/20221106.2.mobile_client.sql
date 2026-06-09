use ombutel;

alter table ombu_devices
 add column `mobile_client` enum('yes', 'no') not null default 'no';