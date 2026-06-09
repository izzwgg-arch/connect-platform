use `ombutel`;

alter table `ombu_extensions`
  drop column `fax_enabled`,
  drop column `fax_auto_send`;

delete from `ombu_modules` where `name` = 'fax';