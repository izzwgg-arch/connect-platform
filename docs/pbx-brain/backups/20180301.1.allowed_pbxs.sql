alter table `astboard`.`pbx`
    modify column `pbx` enum('ombutel','cpbx') not null default 'ombutel';