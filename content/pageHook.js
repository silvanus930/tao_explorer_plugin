(function interceptTaoAppApi() {
  const SOURCE = 'tao-subnet-analytics';
  const INFO_PATTERN = /api\.tao\.app\/api\/beta\/analytics\/subnets\/info\/(\d+)/;

  function publish(netuid, payload) {
    window.dispatchEvent(
      new CustomEvent(`${SOURCE}:subnet-info`, {
        detail: { netuid: Number(netuid), payload },
      })
    );
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    const response = await originalFetch(input, init);

    try {
      const url = typeof input === 'string' ? input : input?.url;
      const match = url && url.match(INFO_PATTERN);
      if (match && response.ok) {
        const clone = response.clone();
        clone
          .json()
          .then((payload) => publish(match[1], payload))
          .catch(() => {});
      }
    } catch {
      // Ignore interception errors.
    }

    return response;
  };
})();
