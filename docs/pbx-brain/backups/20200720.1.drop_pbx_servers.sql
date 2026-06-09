use `sonata_billing`;

alter table `companies`
 drop foreign key `companies_ibfk_1`,
 drop column `pbx_server_id`;

alter table `trunks`
 drop foreign key `trunks_ibfk_2`,
 drop column `pbx_server_id`;

alter table `extensions`
    drop foreign key `extensions_ibfk_2`,
    drop column `pbx_server_id`;

drop table `pbx_servers`;

delete from `module_controllers` where `controller` = 'pbx_servers' or `label` = 'pbx servers';

