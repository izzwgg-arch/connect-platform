use ombutel;

select `tenant_id` into @tenant_id from `ombu_tenants` where `name` = 'vitalpbx';

update `ombu_custom_contexts` set `tenant_id` = @tenant_id where `tenant_id` is null;