use `ombutel`;

alter table `ombu_devices`
    add column `send_push` enum('yes','no') not null default 'no';