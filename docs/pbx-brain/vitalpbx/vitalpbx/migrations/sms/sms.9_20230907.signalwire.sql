use `ombutel`;

alter table `ombu_sms_providers`
    modify column `auth_method` enum(
        'api_key',
        'basic_auth',
        'sid',
        'api_auth',
        'account_auth',
        'app_auth',
        'space_auth'
        ) not null default 'api_key';

alter table `ombu_sms_connections`
    add column `space_url` varchar(255) null default null after application_id;

insert into `ombu_sms_providers` (`provider`, `auth_method`, `format`) values
    ('signalwire', 'space_auth', 'e164');