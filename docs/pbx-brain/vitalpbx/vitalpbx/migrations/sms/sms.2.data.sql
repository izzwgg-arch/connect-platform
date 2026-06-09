use `ombutel`;

insert into ombu_sms_providers (`provider`, `auth_method`, `format`) values
 ('telnyx', 'api_key','e164'),
 ('twilio', 'sid','e164'),
 ('questblue', 'api_auth','10-digit'),
 ('skyetel', 'sid','11-digit');