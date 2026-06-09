alter table `sonata_billing`.`pbx_servers`
    modify column `pbx_format` enum('ombutel','cpbx') not null default 'ombutel';