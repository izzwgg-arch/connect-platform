use `ombutel`;

alter table `ombu_devices`
    drop column `send_push`,
    add column if not exists `generate_qr` enum('yes','no') not null default 'no';