use ombutel;

/* Create Firewall Service and Rule for VitXi WebRTC */
insert ignore into ombu_firewall_services (`name`, `protocol`, `port`) values
    ('VitXi WebRTC', 'tcp', 6001);

set @service_id = last_insert_id();

insert ignore into ombu_firewall_rules (`firewall_service_id`, `action`, `index`) values
    (@service_id, 'accept', 25);

/* Mark firewall module for reload */
select `module_id` into @module from `ombu_modules` where `name` = 'firewall';

insert ignore into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`) values
    (@module, 'reload', 'yes')
on duplicate key update `value` = if(`value` = 'no', values(`value`), `value`);