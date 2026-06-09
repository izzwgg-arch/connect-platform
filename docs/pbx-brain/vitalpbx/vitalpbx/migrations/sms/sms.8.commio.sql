use `ombutel`;

alter table `ombu_sms_providers`
    modify column `auth_method` enum('api_key', 'basic_auth', 'sid', 'api_auth', 'account_auth') not null default 'api_key';

alter table `ombu_sms_connections`
    add column `account_id` varchar(255) null default null after auth_password;

insert into `ombu_sms_providers` (`provider`, `auth_method`, `format`) values
   ('commio', 'account_auth', '11-digit');
