use `ombutel`;

alter table `ombu_devices`
 add column `send_welcome_email` enum ('yes', 'no') not null default 'no';