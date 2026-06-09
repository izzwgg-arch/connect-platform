use ombutel;

create table `ombu_virtual_devices` (
    `device_id` int unsigned not null,
    `number` varchar(255) not null,
    foreign key (`device_id`) references `ombu_devices` (`device_id`) on delete cascade
) engine=innodb default charset=utf8;