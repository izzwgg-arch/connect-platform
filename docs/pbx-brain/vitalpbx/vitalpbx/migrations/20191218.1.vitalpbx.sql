create database if not exists `ombutel`;

create table `ombutel`.`ombu_patches` (
	`patch_id` int unsigned not null auto_increment,
	`filename` varchar(255) not null,
	`applied` timestamp not null,
	primary key (`patch_id`),
	unique (`filename`)
);

grant all on `ombutel`.* to `vitalpbx`@`localhost` identified by 'vitalpbx';