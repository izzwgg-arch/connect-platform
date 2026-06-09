use `ombutel`;

create table if not exists `microsoft_voice_regions` (
    `id` int unsigned not null auto_increment,
    `description` varchar(255) not null,
    `endpoint` varchar(50) not null,
    primary key (`id`),
    unique (`endpoint`)
) character set utf8 collate utf8_unicode_ci;

insert into `microsoft_voice_regions` (`description`, `endpoint`) values
  ('Australia East', 'australiaeast'),
  ('Brazil South', 'brazilsouth'),
  ('Canada Central', 'canadacentral'),
  ('Central US', 'centralus'),
  ('East Asia', 'eastasia'),
  ('East US', 'eastus'),
  ('East US 2', 'eastus2'),
  ('France Central', 'francecentral'),
  ('Germany West Central', 'germanywestcentral'),
  ('India Central', 'centralindia'),
  ('Japan East', 'japaneast'),
  ('Japan West', 'japanwest'),
  ('Jio India West', 'jioindiawest'),
  ('Korea Central', 'koreacentral'),
  ('North Central US', 'northcentralus'),
  ('North Europe', 'northeurope'),
  ('Norway East', 'norwayeast'),
  ('South Central US', 'southcentralus'),
  ('Southeast Asia', 'southeastasia'),
  ('Sweden Central', 'swedencentral'),
  ('Switzerland North', 'switzerlandnorth'),
  ('Switzerland West', 'switzerlandwest'),
  ('UAE North', 'uaenorth'),
  ('US Gov Arizona', 'usgovarizona'),
  ('US Gov Virginia', 'usgovvirginia'),
  ('UK South', 'uksouth'),
  ('West Central US', 'westcentralus'),
  ('West Europe', 'westeurope'),
  ('West US', 'westus'),
  ('West US 2', 'westus2'),
  ('West US 3', 'westus3');
