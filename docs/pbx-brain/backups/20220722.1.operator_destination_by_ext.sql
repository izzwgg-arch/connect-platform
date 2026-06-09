use `ombutel`;

/* Operator Destination by Voicemail */
alter table ombu_extensions_vm
 add column if not exists `operator_destination_id` int unsigned null default null,
 add foreign key if not exists `oev_dest_operator` (`operator_destination_id`) references `ombu_destinations` (`id`) on delete set null;

/* Update the extensions operator destination with the value from Voicemail Settings module */
select `module_id` into @module_id from `ombu_modules` where `name` = 'voicemail_general';
select `tenant_id` into @tenant from `ombu_tenants` where `name` = 'vitalpbx';

select
    if(`value` = '', null, `value`) into @destination
from `ombu_settings`
where `module_id` = @module_id and `name` = 'operator_destination'
limit 1;

update `ombu_extensions_vm` evm
inner join ombu_extensions e on evm.extension_id = e.extension_id
 set evm.`operator_destination_id` = @destination
where e.tenant_id = @tenant;

/* Remove the operator configs from the settings table */
delete from `ombu_settings` where `name` = 'operator_destination' and `module_id` = @module_id;
delete from `ombu_settings` where `name` = 'operator' and `module_id` = @module_id;