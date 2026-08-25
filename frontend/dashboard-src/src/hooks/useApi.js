import { useEffect, useRef, useState } from "react";
import { UnauthenticatedError } from "../lib/api";
import { useSession } from "./useSession";

// Runs `fetcher({ signal })` on mount and on every dep change, optionally
// polling every `pollMs`. Mirrors the vanilla route()'s fetch +
// full-view-refresh cadence, but with per-request AbortController cleanup
// (the vanilla version had none — polls/route changes could race).
//
// Still depends on activeWorkspace to retrigger a refetch on switch, even
// though it's no longer threaded into the fetcher as a param - workspace
// context now travels in the JWT itself (see SessionContext's
// switchWorkspace), not a per-request header, so there's nothing left for
// the fetcher to do with it except know that IT happened.
export function useApi(fetcher, { pollMs, deps = [], enabled = true } = {}) {
  const { activeWorkspace, markUnauthenticated } = useSession();
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    let controller = new AbortController();

    async function run() {
      controller = new AbortController();
      try {
        const data = await fetcherRef.current({ signal: controller.signal });
        if (!cancelled) setState({ data, error: null, loading: false });
      } catch (err) {
        if (cancelled || err.name === "AbortError") return;
        if (err instanceof UnauthenticatedError) {
          markUnauthenticated();
          return;
        }
        console.error(err);
        setState({ data: null, error: err, loading: false });
      }
    }

    setState((s) => ({ ...s, loading: true }));
    run();

    let interval;
    if (pollMs) interval = setInterval(run, pollMs);

    return () => {
      cancelled = true;
      controller.abort();
      if (interval) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspace, pollMs, enabled, ...deps]);

  return state;
}
