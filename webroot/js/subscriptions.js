function integerOr(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

export function normalizeSubscriptions(rawSubscriptions, requestedSubId) {
  const subscriptions = (Array.isArray(rawSubscriptions) ? rawSubscriptions : [])
    .map((subscription, index) => ({
      subId: integerOr(subscription?.subId, -1),
      slotIndex: integerOr(subscription?.slotIndex ?? subscription?.slot, index),
      carrierName: String(subscription?.carrierName ?? subscription?.carrier ?? ''),
      displayName: String(subscription?.displayName ?? subscription?.name ?? ''),
      defaultData: Boolean(subscription?.defaultData ?? subscription?.isDefaultData),
    }))
    .filter((subscription) => subscription.subId >= 0);

  const fallback = subscriptions.find((subscription) => subscription.defaultData)
    || subscriptions[0]
    || null;
  const requested = integerOr(requestedSubId, fallback?.subId ?? -1);
  const selected = subscriptions.find((subscription) => subscription.subId === requested)
    || fallback;

  return {
    subscriptions,
    selectedSubId: selected?.subId ?? -1,
    slotIndex: selected?.slotIndex ?? -1,
  };
}

export function subscriptionLabel(subscription, includeCarrier = false) {
  if (!subscription || subscription.subId < 0) return 'SIM unavailable';
  const base = subscription.slotIndex >= 0
    ? `SIM ${subscription.slotIndex + 1}`
    : `Subscription ${subscription.subId}`;
  return includeCarrier && subscription.carrierName
    ? `${base} · ${subscription.carrierName}`
    : base;
}
