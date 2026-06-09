use `ombutel`;

insert into `ombu_sms_providers` (`provider`, `auth_method`, `format`) values
    ('voipms', 'basic_auth', '10-digit'),
    ('didww', 'basic_auth', 'e164');