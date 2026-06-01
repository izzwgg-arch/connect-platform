export type ContactFilterOption = {
  value: string;
  label: string;
};

export type ContactFilterTag = {
  tag: {
    id: string;
    name: string;
  };
  count: number;
};

export type ContactFilterCampaign = {
  id: string;
  name: string;
};

export function buildCampaignFilterOptions(campaigns: ContactFilterCampaign[]): ContactFilterOption[] {
  return [
    { value: "all", label: "All campaigns" },
    ...campaigns.map((campaign) => ({ value: campaign.id, label: campaign.name })),
  ];
}

export function buildTagFilterOptions(tags: ContactFilterTag[]): ContactFilterOption[] {
  return [
    { value: "all", label: "All tags" },
    ...tags.map(({ tag, count }) => ({
      value: tag.id,
      label: `${tag.name} (${count})`,
    })),
  ];
}

export function buildTimezoneFilterOptions<T extends string>(
  options: Array<{ value: T; label: string }>,
): ContactFilterOption[] {
  return options.map((option) => ({ value: option.value, label: option.label }));
}

export function buildStageFilterOptions<T extends string>(
  tabs: T[],
  labels: Record<T, string>,
): ContactFilterOption[] {
  return tabs.map((tab) => ({ value: tab, label: labels[tab] }));
}
