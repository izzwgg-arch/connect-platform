use `ombutel`;

create index if not exists idx_extension_tenant ON ombu_extensions (extension, tenant_id);
create index if not exists idx_extension on ombu_extensions (extension);
create index if not exists idx_name_tenant on ombu_extensions (name, tenant_id);
create index if not exists idx_sms_tenant on ombu_extensions (sms_number_id, tenant_id);
create index if not exists idx_dialprofile_tenant on ombu_extensions (dial_profile_id, tenant_id);
create index if not exists idx_extension_tenant_tech ON ombu_devices (extension_id, tenant_id, technology);
create index if not exists idx_extension_tech ON ombu_devices (extension_id, technology);
create index if not exists idx_user ON ombu_devices (user);
create index if not exists idx_user_tenant ON ombu_devices (user, tenant_id);
create index if not exists idx_description_tenant ON ombu_devices (description, tenant_id);
create index if not exists idx_extension_tenant ON ombu_devices (extension_id, tenant_id);
create index if not exists idx_extension_assignedexten_tenant ON ombu_devices (extension_id, assigned_exten, tenant_id);
create index if not exists idx_assignedexten_tenant ON ombu_devices (assigned_exten, tenant_id);
