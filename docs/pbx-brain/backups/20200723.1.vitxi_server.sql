use `ombutel`;

alter table `ombu_devices`
 add column `vitxi_client` enum('yes', 'no') not null default 'no' after `send_push`;