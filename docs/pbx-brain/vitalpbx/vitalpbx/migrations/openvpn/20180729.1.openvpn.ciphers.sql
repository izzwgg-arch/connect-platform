insert into `ombutel`.`ombu_settings` (`module_id`, `name`, `value`)
  select `module_id`,
    'cipher',
    'BF-CBC'
  from `ombutel`.`ombu_modules`
  where `name` = 'vpn_server';