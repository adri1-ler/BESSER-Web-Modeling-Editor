// tslint:disable-next-line:ban-types
/**
 * Returns a throttled version of `func` that fires at most once per `wait` ms.
 * Leading call fires immediately; a trailing call is always scheduled so the
 * final state is never dropped (important for drag-end model snapshots).
 */
export function throttle(func: Function, wait: number = 50) {
  let timeout: number | undefined;
  let lastCallTime = 0;

  return function (...args: any[]) {
    // @ts-ignore
    const context = this;
    const now = Date.now();
    const remaining = wait - (now - lastCallTime);

    if (remaining <= 0) {
      // Enough time has elapsed — fire immediately (leading).
      if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      lastCallTime = now;
      func.apply(context, args);
    } else {
      // Still within the throttle window — schedule a trailing call.
      clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        lastCallTime = Date.now();
        timeout = undefined;
        func.apply(context, args);
      }, remaining);
    }
  };
}
