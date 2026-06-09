use `ombutel`;

alter table `ombu_sms_providers`
    modify column `auth_method` enum('api_key', 'basic_auth', 'sid', 'api_auth', 'account_auth', 'app_auth') not null default 'api_key';

alter table `ombu_sms_connections`
    add column `application_id` varchar(255) null default null after account_id;

insert into `ombu_sms_providers` (`provider`, `auth_method`, `format`) values
    ('wavix', 'api_key', 'e164'),
    ('bandwidth', 'app_auth', 'e164'),
    ('voxtelesys', 'api_key', 'e164');