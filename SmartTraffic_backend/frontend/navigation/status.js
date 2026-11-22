/**
 * Page-level status: offline banner and short notices. Data freshness for
 * individual observations is computed in trafficStore.js and shown where the
 * data is shown.
 */
export function createStatus({ banner, toast }) {
  let toastTimer = null;

  return {
    setOffline(offline) {
      banner.hidden = !offline;
    },

    /** Short notice, read by screen readers (role="status" on the element). */
    notify(message, { tone = 'info', timeoutMs = 5000 } = {}) {
      clearTimeout(toastTimer);
      toast.textContent = message;
      toast.dataset.tone = tone;
      toast.hidden = false;
      toastTimer = setTimeout(() => { toast.hidden = true; }, timeoutMs);
    },
  };
}
