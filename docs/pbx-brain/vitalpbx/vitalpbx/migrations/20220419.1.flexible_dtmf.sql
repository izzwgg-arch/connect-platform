use `ombutel`;

alter table `ombu_pjsip_devices`
 modify column `dtmfmode` varchar(255) null default null;

alter table `ombu_sip_devices`
 modify column `dtmfmode` varchar(255) null default null;