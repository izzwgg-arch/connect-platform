use `ombutel`;

/* Add timezone setting */
insert into `ombu_tenant_settings` (`tenant_id`, `name`, `value`)
  select
   `tenant_id`,
    'timezone',
    'system'
  from ombu_tenants where `default` = 'no';

/* Add addons setting to allow/disallow sonata add-ons */
insert into `ombu_tenant_settings` (`tenant_id`, `name`, `value`)
select
    `tenant_id`,
    'addons',
    null
from ombu_tenants where `default` = 'no';