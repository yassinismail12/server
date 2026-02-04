async function debugToken(pageAccessToken, expectedPageId) {
  const res = await fetch(
    `https://graph.facebook.com/me?fields=id,name&access_token=EAAQK9ZB4dVZAkBQiOeI1Mz2TepHcVuY7edn1FfYs74dkq00NaOOzNEoLBKcsi8kfRmeywYyF91hKsGMWRBxiW0bSzLbc2GtFaUUQMmOaFifQDpFVOnZBT5ZAosRiAhq2mo5f4dRhWnasWCe6kMPUpES0yO6TZA0RfsPaSU0rQ1iIQ7WojfEDg6ARHFyTfgEnVPsvVEAQBlMncsKecVser6AZDZD`
  );
  const data = await res.json();
  console.log("🔐 Token debug /me:", data, { expectedPageId });
}
